import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { MonitoringState } from '../../../shared/monitoring';
import { makeHookJournalBaseName } from '../hooks/hook-journal-reader';
import {
  MAX_JOURNAL_ENTRIES,
  isJournalName,
  statJournals,
  verifyJournal,
  type JournalCandidate,
} from './journal-discovery';

/** An ended journal untouched for longer than this is removed with its archives. */
export const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** Every discovery pass requests a sweep; one runs at most this often. */
export const JOURNAL_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;
/** Journals whose head and tail are read per sweep to learn whether they ended. */
export const MAX_SWEEP_PROBES = 64;
/** Journal sets removed per sweep; a backlog drains oldest first across sweeps. */
export const MAX_SWEEP_REMOVALS = 64;
/** The helper keeps `.1` through `.3` beside the active file. */
const MAX_ARCHIVES = 3;
const CLAUDE_SESSION_PREFIX = 'claude:';
const CLAUDE_SURFACE_KEYS = ['claude:desktop', 'claude:cli'] as const;

/** Counts only; a sweep never reports a name or a path. */
export interface ClaudeJournalSweep {
  /** Journals read to learn whether their newest record is `SessionEnd`. */
  probed: number;
  /** Ended journals removed with every archive. */
  removed: number;
  /**
   * Ended journals left alone because a path of their set was a symlink or
   * not a regular file, or one for the whole sweep when the journal directory
   * itself is not a real directory.
   */
  refused: number;
  /** Reads, removals, or listings that failed on an I/O error; retried on a later sweep. */
  failed: number;
}

export interface ClaudeJournalCollectorOptions {
  /** The app's private data directory; journals live under `journals/claude`. */
  appDataPath: string;
  /**
   * Base names that must survive a sweep whatever their state: every journal
   * in a surface's cohort, with a persisted cursor, or with a persisted
   * session. A callback that throws skips the sweep.
   */
  retained: () => ReadonlySet<string>;
  now?: () => number;
  retentionMs?: number;
  sweepIntervalMs?: number;
  /** Per-sweep bounds; tests lower them. */
  maxProbes?: number;
  maxRemovals?: number;
}

interface Verdict {
  mtimeMs: number;
  size: number;
  ended: boolean;
}

type Removal = 'removed' | 'refused' | 'failed' | 'changed';
type PathState = 'present' | 'absent' | 'refused' | 'changed';

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Journals the app still refers to: each monitor's current cohort, every
 * persisted cursor (keyed by the journal base name), and every persisted
 * Claude session (whose ID hashes to one).
 */
export function retainedClaudeJournals(
  state: MonitoringState,
  monitors: Iterable<{ readonly cohort: ReadonlySet<string> }>,
): Set<string> {
  const retained = new Set<string>();
  for (const monitor of monitors) {
    for (const baseName of monitor.cohort) retained.add(baseName);
  }
  for (const key of CLAUDE_SURFACE_KEYS) {
    const partition = state.partitions[key];
    for (const sourceId of Object.keys(partition.cursors)) retained.add(sourceId);
    for (const sessionId of Object.keys(partition.sessions)) {
      if (!sessionId.startsWith(CLAUDE_SESSION_PREFIX)) continue;
      retained.add(
        makeHookJournalBaseName('claude', sessionId.slice(CLAUDE_SESSION_PREFIX.length)),
      );
    }
  }
  return retained;
}

/**
 * The names to stat this sweep. A directory within the stat bound is taken
 * whole; a larger one is walked in sorted windows that continue where the
 * previous sweep stopped, so every journal is reached even when the first
 * window holds nothing collectable.
 */
export function journalWindow(present: ReadonlySet<string>, after: string | undefined): string[] {
  if (present.size <= MAX_JOURNAL_ENTRIES) return [...present];
  const sorted = [...present].sort();
  let start = after === undefined ? 0 : sorted.findIndex((name) => name > after);
  if (start < 0) start = 0;
  const window = sorted.slice(start, start + MAX_JOURNAL_ENTRIES);
  if (window.length < MAX_JOURNAL_ENTRIES) {
    window.push(...sorted.slice(0, MAX_JOURNAL_ENTRIES - window.length));
  }
  return window;
}

/**
 * Bounded garbage collection for the app's own Claude journal directory. A
 * sweep removes every suffix (`.jsonl.3`, `.2`, `.1`, then the active file)
 * of a verified journal whose newest record is `SessionEnd` and whose active
 * file is older than the retention window, and nothing else: a journal that
 * was killed without `SessionEnd`, that cannot be verified as this app's, or
 * that the coordinator still refers to stays. Symlinks and non-files are
 * never followed or removed; one in a journal set leaves the whole set alone.
 * Lock files stay, so the helper's no-stale-lock guarantee holds. Sweeps are
 * throttled, single-flight, bounded per pass, and report counts only.
 */
export class ClaudeJournalCollector {
  private readonly directory: string;
  private readonly retained: () => ReadonlySet<string>;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxProbes: number;
  private readonly maxRemovals: number;
  /** Verdicts for journals already read, so an unchanged file is not re-read every sweep. */
  private readonly verdicts = new Map<string, Verdict>();
  /** Where the last window of an oversized directory stopped. */
  private windowAfter: string | undefined;
  private lastSweepAt: number | undefined;
  private inFlight: Promise<ClaudeJournalSweep> | undefined;

  constructor(options: ClaudeJournalCollectorOptions) {
    this.directory = join(options.appDataPath, 'journals', 'claude');
    this.retained = options.retained;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? JOURNAL_RETENTION_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? JOURNAL_SWEEP_INTERVAL_MS;
    this.maxProbes = options.maxProbes ?? MAX_SWEEP_PROBES;
    this.maxRemovals = options.maxRemovals ?? MAX_SWEEP_REMOVALS;
  }

  /**
   * Run one sweep unless one ran within the interval or is running now.
   * Resolves with the counts of the sweep that ran, or undefined when the
   * request was throttled. Never rejects.
   */
  sweep(): Promise<ClaudeJournalSweep | undefined> {
    if (this.inFlight !== undefined) return this.inFlight;
    const now = this.now();
    if (this.lastSweepAt !== undefined && now - this.lastSweepAt < this.sweepIntervalMs) {
      return Promise.resolve(undefined);
    }
    // A failed sweep waits for the next interval like a successful one.
    this.lastSweepAt = now;
    this.inFlight = this.sweepOnce(now - this.retentionMs)
      .catch((): ClaudeJournalSweep => ({ probed: 0, removed: 0, refused: 0, failed: 1 }))
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async sweepOnce(cutoffMs: number): Promise<ClaudeJournalSweep> {
    const sweep: ClaudeJournalSweep = { probed: 0, removed: 0, refused: 0, failed: 0 };
    let retained: ReadonlySet<string>;
    try {
      retained = this.retained();
    } catch {
      return { ...sweep, failed: 1 };
    }
    let names: string[];
    try {
      // The directory itself must be a real directory, never a link elsewhere.
      if (!(await lstat(this.directory)).isDirectory()) return { ...sweep, refused: 1 };
      names = await readdir(this.directory);
    } catch (error) {
      return isMissing(error) ? sweep : { ...sweep, failed: 1 };
    }
    const present = new Set(names.filter(isJournalName));
    for (const name of this.verdicts.keys()) {
      if (!present.has(name)) this.verdicts.delete(name);
    }
    const window = journalWindow(present, this.windowAfter);
    this.windowAfter = present.size > MAX_JOURNAL_ENTRIES ? window[window.length - 1] : undefined;
    const candidates = (await statJournals(this.directory, window)).filter(
      (candidate) => candidate.mtimeMs < cutoffMs,
    );
    // Oldest first, so a backlog drains in order and a journal that keeps
    // looking live is read once and then skipped by its verdict.
    candidates.sort(
      (left, right) => left.mtimeMs - right.mtimeMs || (left.name < right.name ? -1 : 1),
    );
    for (const candidate of candidates) {
      if (retained.has(candidate.name.slice(0, -'.jsonl'.length))) continue;
      let verdict = this.verdicts.get(candidate.name);
      if (
        verdict === undefined ||
        verdict.mtimeMs !== candidate.mtimeMs ||
        verdict.size !== candidate.size
      ) {
        // Over budget, a journal already judged still gets its turn below.
        if (sweep.probed >= this.maxProbes) continue;
        sweep.probed += 1;
        try {
          const summary = await verifyJournal(this.directory, candidate);
          verdict = {
            mtimeMs: candidate.mtimeMs,
            size: candidate.size,
            ended: summary?.ended === true,
          };
        } catch {
          // Unreadable right now is not a verdict; read it again next sweep.
          sweep.failed += 1;
          continue;
        }
        this.verdicts.set(candidate.name, verdict);
      }
      if (!verdict.ended) continue;
      if (sweep.removed + sweep.refused + sweep.failed >= this.maxRemovals) break;
      const removal = await this.removeSet(candidate);
      if (removal === 'removed') {
        this.verdicts.delete(candidate.name);
        sweep.removed += 1;
      } else if (removal === 'refused') {
        sweep.refused += 1;
      } else if (removal === 'failed') {
        sweep.failed += 1;
      }
      // A journal that changed since it was read is a session that woke up;
      // its next verdict decides.
    }
    return sweep;
  }

  /** Every path of one journal set, oldest archive first and the active file last. */
  private setPaths(candidate: JournalCandidate): string[] {
    const active = join(this.directory, candidate.name);
    const paths: string[] = [];
    for (let index = MAX_ARCHIVES; index >= 1; index -= 1) paths.push(`${active}.${index}`);
    paths.push(active);
    return paths;
  }

  /**
   * Remove the archives first and the active file last, so an interrupted
   * removal leaves an ended active file to finish on a later sweep rather
   * than an orphaned archive nothing would ever judge. Every path is checked
   * before any is touched, and the active file must be exactly the file that
   * was read: a newer modification time or size means the session woke up.
   */
  private async removeSet(candidate: JournalCandidate): Promise<Removal> {
    const paths = this.setPaths(candidate);
    const active = paths[paths.length - 1]!;
    const check = async (path: string): Promise<PathState> => {
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (isMissing(error)) return 'absent';
        throw error;
      }
      if (!metadata.isFile()) return 'refused';
      const changed =
        path === active &&
        (metadata.mtimeMs !== candidate.mtimeMs || metadata.size !== candidate.size);
      return changed ? 'changed' : 'present';
    };
    try {
      for (const path of paths) {
        const state = await check(path);
        if (state === 'refused' || state === 'changed') return state;
      }
      for (const path of paths) {
        // Re-check at the moment of removal. `unlink` never follows a link,
        // so even a link swapped in after the check removes only itself.
        const state = await check(path);
        if (state === 'refused' || state === 'changed') return state;
        if (state === 'present') await unlink(path);
      }
      return 'removed';
    } catch {
      return 'failed';
    }
  }
}

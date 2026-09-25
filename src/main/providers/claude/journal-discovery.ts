import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { RECENT_THREAD_DISCOVERY_WINDOW } from '../../../shared/settings';
import type { Surface } from '../../../shared/session';
import {
  HOOK_JOURNAL_HOSTS,
  isSafeString,
  makeHookJournalBaseName,
  type HookJournalEvent,
} from '../hooks/hook-journal-reader';

/** Hash-named journals stat'ed per discovery; the newest ones are inspected. */
export const MAX_JOURNAL_ENTRIES = 4_096;
/** Journals inspected per discovery, before the surface filter and the window. */
export const MAX_INSPECTED_JOURNALS = 64;
/** Enough for one complete record at the head and at the tail of a journal. */
const PROBE_BYTES = 8 * 1024;
const MAX_ID_BYTES = 256;
const JOURNAL_NAME = /^[a-f0-9]{64}\.jsonl$/u;

/** The active journal of one session: a hash base name plus `.jsonl`. */
export function isJournalName(name: string): boolean {
  return JOURNAL_NAME.test(name);
}

export function isMissingError(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'ENOENT';
}

export type ClaudeHost = NonNullable<HookJournalEvent['host']>;

/** Display-safe facts about one journal; the path never leaves this module. */
export interface ClaudeJournalSummary {
  /** Hash basename; the runtime source and cursor key. */
  baseName: string;
  nativeSessionId: string;
  projectName?: string;
  /** Desktop when the newest identified record came from Claude Desktop, else CLI. */
  surface: Surface;
  /** The newest record is `SessionEnd`; the session left the cohort. */
  ended: boolean;
  updatedAt: number;
  /** Active file size at listing; reported to the coordinator as the source boundary. */
  endOffset: number;
}

/** One `lstat` of an active journal; shared with the collector. */
export interface JournalCandidate {
  name: string;
  mtimeMs: number;
  size: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: ClaudeJournalSummary | undefined;
  /** Passes this entry was kept without a readable active file; a rotation takes one. */
  retainedPasses: number;
}

/** A rotation is milliseconds; a session still absent after this many passes is gone. */
const MAX_RETAINED_PASSES = 2;

interface Probe {
  sessionId?: string;
  projectName?: string;
  host?: ClaudeHost;
  entrypoint?: string;
  eventName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, maxBytes: number): string | undefined {
  return isSafeString(value, maxBytes) ? value : undefined;
}

function probeOf(line: string): Probe | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.schema_version !== 1 || parsed.provider !== 'claude') {
    return undefined;
  }
  const host = optionalString(parsed.host, 64);
  return {
    sessionId: optionalString(parsed.session_id, MAX_ID_BYTES),
    projectName: optionalString(parsed.project_name, MAX_ID_BYTES),
    host: host !== undefined && HOOK_JOURNAL_HOSTS.has(host) ? (host as ClaudeHost) : undefined,
    entrypoint: optionalString(parsed.entrypoint, 64),
    eventName: optionalString(parsed.event_name, 64),
  };
}

/** First complete line of the head chunk and last complete line of the tail chunk. */
async function probeJournal(path: string, size: number): Promise<[Probe, Probe] | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const headLength = Math.min(size, PROBE_BYTES);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    const tailStart = Math.max(0, size - PROBE_BYTES);
    const tail = tailStart === 0 && headLength === size ? head : Buffer.alloc(size - tailStart);
    if (tail !== head) await handle.read(tail, 0, tail.length, tailStart);
    const headLines = head.toString('utf8').split('\n');
    // A first line longer than the probe has no terminator inside the chunk.
    const firstLine = headLines.length > 1 ? headLines[0] : undefined;
    const tailLines = tail.toString('utf8').split('\n');
    // The last element is the unterminated remainder (or empty after a newline).
    tailLines.pop();
    const lastLine = tailLines.length > 0 ? tailLines[tailLines.length - 1] : undefined;
    if (firstLine === undefined || lastLine === undefined) return undefined;
    const first = probeOf(firstLine);
    const last = probeOf(lastLine);
    return first === undefined || last === undefined ? undefined : [first, last];
  } finally {
    await handle.close();
  }
}

/**
 * `lstat` the named active journals, at most `MAX_JOURNAL_ENTRIES` of them in
 * the given order, keeping regular files only; a name that cannot be
 * stat'ed is skipped. Shared by discovery and the collector.
 */
export async function statJournals(
  directory: string,
  names: Iterable<string>,
): Promise<JournalCandidate[]> {
  const candidates: JournalCandidate[] = [];
  let statted = 0;
  for (const name of names) {
    if (statted >= MAX_JOURNAL_ENTRIES) break;
    statted += 1;
    try {
      const metadata = await lstat(join(directory, name));
      if (!metadata.isFile()) continue;
      candidates.push({ name, mtimeMs: metadata.mtimeMs, size: metadata.size });
    } catch {
      continue;
    }
  }
  return candidates;
}

export function surfaceForIdentity(
  host: ClaudeHost | undefined,
  entrypoint: string | undefined,
): Surface {
  return host === 'claude-desktop' || entrypoint === 'claude-desktop' ? 'desktop' : 'cli';
}

/**
 * Bounded listing of the app's own Claude journal directory. It never scans
 * the user's home directory: the helper wrote every file here, each file is
 * verified against the hash of the session ID it claims, and only display-safe
 * metadata is returned. Missing directories mean no sessions. One instance is
 * shared by both surface monitors; overlapping calls share one listing, and
 * unchanged journals are not probed again.
 */
export class ClaudeJournalDiscovery {
  private readonly directory: string;
  private readonly cache = new Map<string, CacheEntry>();
  private inFlight: Promise<readonly ClaudeJournalSummary[]> | undefined;
  private wasTruncated = false;
  private lastSummaries: readonly ClaudeJournalSummary[] = [];

  constructor(options: { appDataPath: string }) {
    this.directory = join(options.appDataPath, 'journals', 'claude');
  }

  /** True when the last listing had more journals than it could stat. */
  get truncated(): boolean {
    return this.wasTruncated;
  }

  /** The last listing; the collector derives both surfaces' cohorts from it. */
  get summaries(): readonly ClaudeJournalSummary[] {
    return this.lastSummaries;
  }

  /** Both surface monitors call this every pass; concurrent calls share one listing. */
  list(): Promise<readonly ClaudeJournalSummary[]> {
    if (this.inFlight === undefined) {
      this.inFlight = this.listOnce().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async listOnce(): Promise<readonly ClaudeJournalSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissingError(error)) {
        this.cache.clear();
        this.wasTruncated = false;
        this.lastSummaries = [];
        return [];
      }
      throw error;
    }
    const present = new Set(names.filter(isJournalName));
    this.wasTruncated = present.size > MAX_JOURNAL_ENTRIES;
    const candidates = await statJournals(this.directory, present);
    candidates.sort(
      (left, right) => right.mtimeMs - left.mtimeMs || (left.name < right.name ? -1 : 1),
    );
    const inspected = new Set<string>();
    const summaries: ClaudeJournalSummary[] = [];
    for (const candidate of candidates.slice(0, MAX_INSPECTED_JOURNALS)) {
      inspected.add(candidate.name);
      const cached = this.cache.get(candidate.name);
      if (
        cached !== undefined &&
        cached.mtimeMs === candidate.mtimeMs &&
        cached.size === candidate.size
      ) {
        if (cached.summary !== undefined) summaries.push(cached.summary);
        continue;
      }
      if (
        candidate.size === 0 &&
        cached?.summary !== undefined &&
        (await this.retain(candidate.name, cached))
      ) {
        summaries.push(cached.summary);
        continue;
      }
      const summary = await summarizeJournal(this.directory, candidate);
      this.cache.set(candidate.name, {
        mtimeMs: candidate.mtimeMs,
        size: candidate.size,
        summary,
        retainedPasses: 0,
      });
      if (summary !== undefined) summaries.push(summary);
    }
    for (const [name, cached] of this.cache) {
      if (inspected.has(name)) continue;
      // A journal that merely fell out of the newest set is forgotten; one
      // whose active file vanished is kept only while a rotation explains it.
      if (!present.has(name) && cached.summary !== undefined && (await this.retain(name, cached))) {
        summaries.push(cached.summary);
        continue;
      }
      this.cache.delete(name);
    }
    // Retained entries were appended out of order.
    summaries.sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || (left.baseName < right.baseName ? -1 : 1),
    );
    this.lastSummaries = summaries;
    return summaries;
  }

  /**
   * The helper rotates by renaming the active file to `.1` and recreating it,
   * so for a moment the active file is absent or empty. Keep the previous
   * summary for a bounded number of passes while the archive proves the
   * rotation; anything longer is a deleted journal.
   */
  private async retain(name: string, cached: CacheEntry): Promise<boolean> {
    if (cached.retainedPasses >= MAX_RETAINED_PASSES) return false;
    if (!(await this.hasArchive(name))) return false;
    cached.retainedPasses += 1;
    return true;
  }

  private async hasArchive(name: string): Promise<boolean> {
    try {
      return (await lstat(join(this.directory, `${name}.1`))).isFile();
    } catch {
      return false;
    }
  }
}

/**
 * Verify one journal and describe it. Only a file whose first record names
 * the session hashed into its file name and whose last record belongs to the
 * same session is ours to describe; anything else, including an empty file,
 * yields nothing. A file that cannot be read rejects, so a caller that
 * remembers verdicts can tell "not ours" from "not readable right now". The
 * path never leaves this module.
 */
export async function verifyJournal(
  directory: string,
  candidate: JournalCandidate,
): Promise<ClaudeJournalSummary | undefined> {
  if (candidate.size === 0) return undefined;
  const probes = await probeJournal(join(directory, candidate.name), candidate.size);
  if (probes === undefined) return undefined;
  const [first, last] = probes;
  const nativeSessionId = first.sessionId;
  if (nativeSessionId === undefined) return undefined;
  const baseName = candidate.name.slice(0, -'.jsonl'.length);
  if (makeHookJournalBaseName('claude', nativeSessionId) !== baseName) return undefined;
  if (last.sessionId !== nativeSessionId) return undefined;
  const host = last.host ?? first.host;
  const entrypoint = last.entrypoint ?? first.entrypoint;
  const projectName = last.projectName ?? first.projectName;
  return {
    baseName,
    nativeSessionId,
    ...(projectName === undefined ? {} : { projectName }),
    surface: surfaceForIdentity(host, entrypoint),
    ended: last.eventName === 'SessionEnd',
    updatedAt: Math.round(candidate.mtimeMs),
    endOffset: candidate.size,
  };
}

/** `verifyJournal` for discovery, where an unreadable file is simply not listed. */
async function summarizeJournal(
  directory: string,
  candidate: JournalCandidate,
): Promise<ClaudeJournalSummary | undefined> {
  try {
    return await verifyJournal(directory, candidate);
  } catch {
    return undefined;
  }
}

/** Newest first, capped at the shared discovery window, for one surface. */
export function selectCohort(
  summaries: readonly ClaudeJournalSummary[],
  surface: Surface,
): readonly ClaudeJournalSummary[] {
  return summaries
    .filter((summary) => summary.surface === surface && !summary.ended)
    .slice(0, RECENT_THREAD_DISCOVERY_WINDOW);
}

import { open, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { RECENT_THREAD_DISCOVERY_WINDOW } from '../../../shared/settings';
import type { Surface } from '../../../shared/session';
import { makeHookJournalBaseName, type HookJournalEvent } from '../hooks/hook-journal-reader';

/** Directory entries considered per discovery; the newest ones are inspected. */
export const MAX_JOURNAL_ENTRIES = 512;
/** Journals inspected per discovery, before the surface filter and the window. */
export const MAX_INSPECTED_JOURNALS = 64;
/** Enough for one complete record at the head and at the tail of a journal. */
const PROBE_BYTES = 8 * 1024;
const MAX_ID_BYTES = 256;
const HOSTS = new Set(['claude-desktop', 'terminal', 'iterm2', 'ghostty', 'warp']);

export type ClaudeHost = NonNullable<HookJournalEvent['host']>;

/** Display-safe facts about one journal; the path never leaves this module. */
export interface ClaudeJournalSummary {
  /** Hash basename; the runtime source and cursor key. */
  baseName: string;
  nativeSessionId: string;
  projectName?: string;
  /** Desktop when the newest identified record came from Claude Desktop, else CLI. */
  surface: Surface;
  host?: ClaudeHost;
  /** The newest record is `SessionEnd`; the session left the cohort. */
  ended: boolean;
  updatedAt: number;
  /** Active file size, the fixed replay boundary for a baseline. */
  endOffset: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: ClaudeJournalSummary | undefined;
}

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

function safeString(value: unknown, maxBytes: number): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value) &&
    Buffer.byteLength(value) <= maxBytes
    ? value
    : undefined;
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
  const host = safeString(parsed.host, 64);
  return {
    sessionId: safeString(parsed.session_id, MAX_ID_BYTES),
    projectName: safeString(parsed.project_name, MAX_ID_BYTES),
    host: host !== undefined && HOSTS.has(host) ? (host as ClaudeHost) : undefined,
    entrypoint: safeString(parsed.entrypoint, 64),
    eventName: safeString(parsed.event_name, 64),
  };
}

/** First complete line of the head chunk and last complete line of the tail chunk. */
async function probeJournal(path: string, size: number): Promise<[Probe, Probe] | undefined> {
  const handle = await open(path, 'r');
  try {
    const headLength = Math.min(size, PROBE_BYTES);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    const tailStart = Math.max(0, size - PROBE_BYTES);
    const tail = tailStart === 0 && headLength === size ? head : Buffer.alloc(size - tailStart);
    if (tail !== head) await handle.read(tail, 0, tail.length, tailStart);
    const headLines = head.toString('utf8').split('\n');
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
 * metadata is returned. Missing directories mean no sessions.
 */
export class ClaudeJournalDiscovery {
  private readonly directory: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: { appDataPath: string }) {
    this.directory = join(options.appDataPath, 'journals', 'claude');
  }

  async list(limit = MAX_INSPECTED_JOURNALS): Promise<readonly ClaudeJournalSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return [];
      throw error;
    }
    const candidates: { name: string; mtimeMs: number; size: number }[] = [];
    for (const name of names.slice(0, MAX_JOURNAL_ENTRIES)) {
      if (!/^[a-f0-9]{64}\.jsonl$/u.test(name)) continue;
      try {
        const metadata = await lstat(join(this.directory, name));
        if (!metadata.isFile()) continue;
        candidates.push({ name, mtimeMs: metadata.mtimeMs, size: metadata.size });
      } catch {
        continue;
      }
    }
    candidates.sort(
      (left, right) => right.mtimeMs - left.mtimeMs || (left.name < right.name ? -1 : 1),
    );
    const live = new Set<string>();
    const summaries: ClaudeJournalSummary[] = [];
    for (const candidate of candidates.slice(0, Math.min(limit, MAX_INSPECTED_JOURNALS))) {
      live.add(candidate.name);
      const cached = this.cache.get(candidate.name);
      if (
        cached !== undefined &&
        cached.mtimeMs === candidate.mtimeMs &&
        cached.size === candidate.size
      ) {
        if (cached.summary !== undefined) summaries.push(cached.summary);
        continue;
      }
      const summary = await this.summarize(candidate);
      this.cache.set(candidate.name, { mtimeMs: candidate.mtimeMs, size: candidate.size, summary });
      if (summary !== undefined) summaries.push(summary);
    }
    for (const name of this.cache.keys()) if (!live.has(name)) this.cache.delete(name);
    return summaries;
  }

  private async summarize(candidate: {
    name: string;
    mtimeMs: number;
    size: number;
  }): Promise<ClaudeJournalSummary | undefined> {
    if (candidate.size === 0) return undefined;
    let probes: [Probe, Probe] | undefined;
    try {
      probes = await probeJournal(join(this.directory, candidate.name), candidate.size);
    } catch {
      return undefined;
    }
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
      ...(host === undefined ? {} : { host }),
      ended: last.eventName === 'SessionEnd',
      updatedAt: Math.round(candidate.mtimeMs),
      endOffset: candidate.size,
    };
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

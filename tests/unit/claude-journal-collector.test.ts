import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeJournalCollector,
  JOURNAL_ABANDONED_RETENTION_MS,
  JOURNAL_RETENTION_MS,
  JOURNAL_SWEEP_INTERVAL_MS,
  MAX_SWEEP_PROBES,
  journalWindow,
  retainedClaudeJournals,
  type ClaudeJournalCollectorOptions,
} from '../../src/main/providers/claude/journal-collector';
import { makeHookJournalBaseName } from '../../src/main/providers/hooks/hook-journal-reader';
import { MAX_JOURNAL_ENTRIES } from '../../src/main/providers/claude/journal-discovery';
import { createInitialMonitoringState } from '../../src/main/sessions/persistence';

const roots: string[] = [];
const NOW = 1_800_000_000_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-collector-'));
  roots.push(root);
  await mkdir(join(root, 'journals', 'claude'), { recursive: true, mode: 0o700 });
  return root;
}

function record(sessionId: string, eventName: string): string {
  return `${JSON.stringify({
    schema_version: 1,
    provider: 'claude',
    event_name: eventName,
    session_id: sessionId,
    timestamp: 1_700_000_000_000,
    project_name: 'project',
    host: 'terminal',
  })}\n`;
}

function baseName(sessionId: string): string {
  return makeHookJournalBaseName('claude', sessionId);
}

function journalPath(root: string, sessionId: string, suffix = ''): string {
  return join(root, 'journals', 'claude', `${baseName(sessionId)}.jsonl${suffix}`);
}

/** Write a journal whose newest record decides `ended`, aged `ageMs` before NOW. */
async function seed(
  root: string,
  sessionId: string,
  options: { ended: boolean; ageMs: number; archives?: number; content?: string },
): Promise<void> {
  const content =
    options.content ??
    record(sessionId, 'SessionStart') +
      record(sessionId, 'Stop') +
      (options.ended ? record(sessionId, 'SessionEnd') : '');
  const stamp = new Date(NOW - options.ageMs);
  for (let index = options.archives ?? 0; index >= 1; index -= 1) {
    await writeFile(journalPath(root, sessionId, `.${index}`), record(sessionId, 'Stop'));
    await utimes(journalPath(root, sessionId, `.${index}`), stamp, stamp);
  }
  await writeFile(journalPath(root, sessionId), content);
  await utimes(journalPath(root, sessionId), stamp, stamp);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function collector(
  root: string,
  overrides: Partial<ClaudeJournalCollectorOptions> = {},
): ClaudeJournalCollector {
  return new ClaudeJournalCollector({
    appDataPath: root,
    retained: () => new Set(),
    now: () => NOW,
    ...overrides,
  });
}

const OLD = JOURNAL_RETENTION_MS + 60_000;

describe('claude journal collector', () => {
  it('removes every suffix of an ended journal past retention and nothing else', async () => {
    const root = await appData();
    await seed(root, 'ended-old', { ended: true, ageMs: OLD, archives: 3 });
    await seed(root, 'live-old', { ended: false, ageMs: OLD, archives: 1 });
    await seed(root, 'ended-recent', { ended: true, ageMs: 60_000, archives: 1 });
    // Ended and old, but its name does not hash its session ID: not ours to judge.
    const forged = join(root, 'journals', 'claude', `${'a'.repeat(64)}.jsonl`);
    await writeFile(forged, record('forged', 'SessionStart') + record('forged', 'SessionEnd'));
    await utimes(forged, new Date(NOW - OLD), new Date(NOW - OLD));
    // An empty active file beside an archive is a rotation nothing can judge.
    await seed(root, 'rotating', { ended: true, ageMs: OLD, archives: 1, content: '' });
    // Lock files are the helper's coordination inodes and are never touched.
    await writeFile(join(root, 'journals', 'claude', `${baseName('ended-old')}.lock`), '');
    await writeFile(join(root, 'journals', 'claude', 'notes.txt'), 'ignored');

    const sweep = await collector(root).sweep();
    expect(sweep).toEqual({ probed: 4, removed: 1, refused: 0, failed: 0 });
    for (const suffix of ['', '.1', '.2', '.3']) {
      expect(await exists(journalPath(root, 'ended-old', suffix))).toBe(false);
    }
    expect(await exists(journalPath(root, 'live-old'))).toBe(true);
    expect(await exists(journalPath(root, 'live-old', '.1'))).toBe(true);
    expect(await exists(journalPath(root, 'ended-recent'))).toBe(true);
    expect(await exists(journalPath(root, 'ended-recent', '.1'))).toBe(true);
    expect(await exists(forged)).toBe(true);
    expect(await exists(journalPath(root, 'rotating'))).toBe(true);
    expect(await exists(journalPath(root, 'rotating', '.1'))).toBe(true);
    expect(await exists(join(root, 'journals', 'claude', `${baseName('ended-old')}.lock`))).toBe(
      true,
    );
    expect(await exists(join(root, 'journals', 'claude', 'notes.txt'))).toBe(true);
  });

  it('removes a verified journal that never ended once it has been silent past the longer window', async () => {
    const root = await appData();
    const ABANDONED = JOURNAL_ABANDONED_RETENTION_MS;
    await seed(root, 'abandoned', { ended: false, ageMs: ABANDONED + 1, archives: 2 });
    await seed(root, 'at-boundary', { ended: false, ageMs: ABANDONED });
    await seed(root, 'still-waiting', { ended: false, ageMs: ABANDONED - 1 });
    await seed(root, 'in-cohort', { ended: false, ageMs: ABANDONED + 1_000 });
    // Silent for a month but not this app's journal: the name does not hash its session.
    const forged = join(root, 'journals', 'claude', `${'f'.repeat(64)}.jsonl`);
    await writeFile(forged, record('forged', 'SessionStart'));
    await utimes(forged, new Date(NOW - ABANDONED - 1_000), new Date(NOW - ABANDONED - 1_000));
    // An empty active file beside an archive cannot be verified either.
    await seed(root, 'rotating', {
      ended: false,
      ageMs: ABANDONED + 1_000,
      archives: 1,
      content: '',
    });

    const sweep = await collector(root, {
      retained: () => new Set([baseName('in-cohort')]),
    }).sweep();
    expect(sweep).toEqual({ probed: 5, removed: 1, refused: 0, failed: 0 });
    for (const suffix of ['', '.1', '.2']) {
      expect(await exists(journalPath(root, 'abandoned', suffix))).toBe(false);
    }
    expect(await exists(journalPath(root, 'at-boundary'))).toBe(true);
    expect(await exists(journalPath(root, 'still-waiting'))).toBe(true);
    expect(await exists(journalPath(root, 'in-cohort'))).toBe(true);
    expect(await exists(forged)).toBe(true);
    expect(await exists(journalPath(root, 'rotating'))).toBe(true);
    expect(await exists(journalPath(root, 'rotating', '.1'))).toBe(true);
  });

  it('removes an abandoned journal from a verdict cached while it was younger, and guards it like an ended one', async () => {
    const root = await appData();
    const ABANDONED = JOURNAL_ABANDONED_RETENTION_MS;
    // Judged at eight days: verified, not ended, kept. No re-read is needed
    // once the same file has crossed the longer window.
    await seed(root, 'aging', { ended: false, ageMs: OLD, archives: 1 });
    let now = NOW;
    const gc = collector(root, { now: () => now });
    expect(await gc.sweep()).toEqual({ probed: 1, removed: 0, refused: 0, failed: 0 });
    now += ABANDONED;
    expect(await gc.sweep()).toEqual({ probed: 0, removed: 1, refused: 0, failed: 0 });
    expect(await exists(journalPath(root, 'aging'))).toBe(false);
    expect(await exists(journalPath(root, 'aging', '.1'))).toBe(false);

    // A symlink in an abandoned set refuses it, and growth between the read
    // and the removal keeps every suffix, exactly as for an ended journal.
    await seed(root, 'linked', { ended: false, ageMs: ABANDONED + now - NOW + 1_000 });
    await symlink(journalPath(root, 'aging'), journalPath(root, 'linked', '.3'));
    await seed(root, 'woken', { ended: false, ageMs: ABANDONED + now - NOW + 1_000, archives: 1 });
    let woke = false;
    const racing = collector(root, {
      now: () => now,
      fs: {
        lstat: async (path) => {
          if (!woke && path.endsWith(`${baseName('woken')}.jsonl.1`)) {
            woke = true;
            await appendFile(journalPath(root, 'woken'), record('woken', 'UserPromptSubmit'));
          }
          return lstat(path);
        },
        unlink,
      },
    });
    expect(await racing.sweep()).toEqual({ probed: 2, removed: 0, refused: 1, failed: 0 });
    expect(await exists(journalPath(root, 'linked'))).toBe(true);
    expect(await exists(journalPath(root, 'woken'))).toBe(true);
    expect(await exists(journalPath(root, 'woken', '.1'))).toBe(true);
  });

  it('treats the retention window as a strict age boundary', async () => {
    const root = await appData();
    await seed(root, 'at-boundary', { ended: true, ageMs: JOURNAL_RETENTION_MS });
    await seed(root, 'past-boundary', { ended: true, ageMs: JOURNAL_RETENTION_MS + 1_000 });
    await seed(root, 'inside', { ended: true, ageMs: JOURNAL_RETENTION_MS - 1_000 });

    const sweep = await collector(root).sweep();
    expect(sweep).toMatchObject({ removed: 1 });
    expect(await exists(journalPath(root, 'at-boundary'))).toBe(true);
    expect(await exists(journalPath(root, 'past-boundary'))).toBe(false);
    expect(await exists(journalPath(root, 'inside'))).toBe(true);
  });

  it('keeps journals the listing cohorts or the coordinator still refer to', async () => {
    const root = await appData();
    await seed(root, 'in-cohort', { ended: false, ageMs: OLD });
    await seed(root, 'with-cursor', { ended: true, ageMs: OLD });
    await seed(root, 'with-session', { ended: true, ageMs: OLD });
    await seed(root, 'free', { ended: true, ageMs: OLD });
    const state = createInitialMonitoringState();
    state.partitions['claude:cli'].cursors = {
      [baseName('with-cursor')]: { identity: '1:1', offset: 1 },
    };
    state.partitions['claude:desktop'].sessions = {
      'claude:with-session': {} as never,
      'codex:elsewhere': {} as never,
    };
    const retained = retainedClaudeJournals(state, [
      {
        baseName: baseName('in-cohort'),
        nativeSessionId: 'in-cohort',
        surface: 'cli',
        ended: false,
        updatedAt: 1,
        endOffset: 1,
      },
      // An ended journal is not in any cohort, so the listing does not keep it.
      {
        baseName: baseName('free'),
        nativeSessionId: 'free',
        surface: 'desktop',
        ended: true,
        updatedAt: 1,
        endOffset: 1,
      },
    ]);
    expect(retained).toEqual(
      new Set([baseName('in-cohort'), baseName('with-cursor'), baseName('with-session')]),
    );

    const sweep = await collector(root, { retained: () => retained }).sweep();
    expect(sweep).toMatchObject({ removed: 1 });
    expect(await exists(journalPath(root, 'in-cohort'))).toBe(true);
    expect(await exists(journalPath(root, 'with-cursor'))).toBe(true);
    expect(await exists(journalPath(root, 'with-session'))).toBe(true);
    expect(await exists(journalPath(root, 'free'))).toBe(false);

    // A retained set that cannot be computed skips the sweep entirely.
    await seed(root, 'later', { ended: true, ageMs: OLD });
    const skipped = await collector(root, {
      retained: () => {
        throw new Error('not ready');
      },
    }).sweep();
    expect(skipped).toEqual({ probed: 0, removed: 0, refused: 0, failed: 1 });
    expect(await exists(journalPath(root, 'later'))).toBe(true);
  });

  it('refuses a journal set containing a symlink and never follows one', async () => {
    const root = await appData();
    const outside = join(root, 'outside.jsonl');
    await writeFile(outside, record('victim', 'SessionStart') + record('victim', 'SessionEnd'));
    await utimes(outside, new Date(NOW - OLD), new Date(NOW - OLD));

    // A symlinked archive leaves the whole set, including the real active file.
    await seed(root, 'linked-archive', { ended: true, ageMs: OLD });
    await symlink(outside, journalPath(root, 'linked-archive', '.2'));
    // A symlink at the active path is not a candidate at all.
    await symlink(outside, journalPath(root, 'linked-active'));
    // A directory at an archive path is as unsafe as a link.
    await seed(root, 'dir-archive', { ended: true, ageMs: OLD });
    await mkdir(journalPath(root, 'dir-archive', '.1'));

    let now = NOW;
    const gc = collector(root, { now: () => now });
    expect(await gc.sweep()).toEqual({ probed: 2, removed: 0, refused: 2, failed: 0 });
    expect(await exists(outside)).toBe(true);
    expect(await exists(journalPath(root, 'linked-archive'))).toBe(true);
    expect(await exists(journalPath(root, 'linked-archive', '.2'))).toBe(true);
    expect(await exists(journalPath(root, 'linked-active'))).toBe(true);
    expect(await exists(journalPath(root, 'dir-archive'))).toBe(true);

    // A refused set is not tried again until its active file changes, so a
    // few unsafe sets can never exhaust the removal budget.
    await seed(root, 'ended', { ended: true, ageMs: OLD });
    now += JOURNAL_SWEEP_INTERVAL_MS;
    expect(await gc.sweep()).toEqual({ probed: 1, removed: 1, refused: 0, failed: 0 });
    await rm(journalPath(root, 'dir-archive', '.1'), { recursive: true });
    await seed(root, 'dir-archive', { ended: true, ageMs: OLD - 1_000 });
    now += JOURNAL_SWEEP_INTERVAL_MS;
    expect(await gc.sweep()).toEqual({ probed: 1, removed: 1, refused: 0, failed: 0 });
    expect(await exists(journalPath(root, 'dir-archive'))).toBe(false);
    expect(await exists(journalPath(root, 'linked-archive'))).toBe(true);

    // A journal directory that is itself a link is not swept.
    const linkedRoot = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-collector-'));
    roots.push(linkedRoot);
    await mkdir(join(linkedRoot, 'journals'), { recursive: true });
    await symlink(join(root, 'journals', 'claude'), join(linkedRoot, 'journals', 'claude'));
    await seed(root, 'behind-link', { ended: true, ageMs: OLD });
    expect(await collector(linkedRoot).sweep()).toEqual({
      probed: 0,
      removed: 0,
      refused: 1,
      failed: 0,
    });
    expect(await exists(journalPath(root, 'behind-link'))).toBe(true);
  });

  it('runs at most once per interval, shares a running sweep, and tolerates a missing directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-collector-none-'));
    roots.push(root);
    let now = NOW;
    const gc = collector(root, { now: () => now });
    const empty = { probed: 0, removed: 0, refused: 0, failed: 0 };
    const [first, second] = await Promise.all([gc.sweep(), gc.sweep()]);
    expect(first).toEqual(empty);
    expect(second).toBe(first);
    expect(await gc.sweep()).toBeUndefined();

    await mkdir(join(root, 'journals', 'claude'), { recursive: true, mode: 0o700 });
    await seed(root, 'ended', { ended: true, ageMs: OLD });
    now += JOURNAL_SWEEP_INTERVAL_MS - 1;
    expect(await gc.sweep()).toBeUndefined();
    expect(await exists(journalPath(root, 'ended'))).toBe(true);
    now += 1;
    expect(await gc.sweep()).toMatchObject({ removed: 1 });
    expect(await exists(journalPath(root, 'ended'))).toBe(false);
  });

  it('reads a bounded number of journals per sweep and remembers unchanged verdicts', async () => {
    const root = await appData();
    const total = MAX_SWEEP_PROBES + 4;
    for (let index = 0; index < total; index += 1) {
      const id = `live-${String(index).padStart(3, '0')}`;
      await seed(root, id, { ended: false, ageMs: OLD + total * 1_000 - index * 1_000 });
    }
    // The newest of the old journals is the only ended one; it waits its turn.
    await seed(root, 'ended-last', { ended: true, ageMs: OLD });
    let now = NOW;
    const gc = collector(root, { now: () => now });
    expect(await gc.sweep()).toEqual({
      probed: MAX_SWEEP_PROBES,
      removed: 0,
      refused: 0,
      failed: 0,
    });
    expect(await exists(journalPath(root, 'ended-last'))).toBe(true);

    now += JOURNAL_SWEEP_INTERVAL_MS;
    expect(await gc.sweep()).toEqual({ probed: 5, removed: 1, refused: 0, failed: 0 });
    expect(await exists(journalPath(root, 'ended-last'))).toBe(false);

    // A journal that ended since its last verdict is read again.
    await seed(root, 'live-000', { ended: true, ageMs: OLD });
    now += JOURNAL_SWEEP_INTERVAL_MS;
    expect(await gc.sweep()).toEqual({ probed: 1, removed: 1, refused: 0, failed: 0 });
    expect(await exists(journalPath(root, 'live-000'))).toBe(false);
    expect((await readdir(join(root, 'journals', 'claude'))).length).toBe(total - 1);
  });

  it('bounds removals per sweep and still removes journals judged on an earlier sweep', async () => {
    const root = await appData();
    for (let index = 0; index < 5; index += 1) {
      await seed(root, `ended-${index}`, { ended: true, ageMs: OLD + (5 - index) * 1_000 });
    }
    let now = NOW;
    const gc = collector(root, { now: () => now, maxProbes: 3, maxRemovals: 2 });
    // Three are read, two removed; the third keeps its verdict for next time.
    expect(await gc.sweep()).toEqual({ probed: 3, removed: 2, refused: 0, failed: 0 });
    now += JOURNAL_SWEEP_INTERVAL_MS;
    // Reading stays bounded, but the journal already judged needs no read.
    expect(await gc.sweep()).toEqual({ probed: 2, removed: 2, refused: 0, failed: 0 });
    now += JOURNAL_SWEEP_INTERVAL_MS;
    expect(await gc.sweep()).toEqual({ probed: 0, removed: 1, refused: 0, failed: 0 });
    expect(await readdir(join(root, 'journals', 'claude'))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'does not turn a transient read error or a failed removal into a lasting verdict',
    async () => {
      const root = await appData();
      await seed(root, 'unreadable', { ended: true, ageMs: OLD });
      await chmod(journalPath(root, 'unreadable'), 0o000);
      let now = NOW;
      const gc = collector(root, { now: () => now });
      expect(await gc.sweep()).toEqual({ probed: 1, removed: 0, refused: 0, failed: 1 });
      await chmod(journalPath(root, 'unreadable'), 0o600);
      now += JOURNAL_SWEEP_INTERVAL_MS;
      expect(await gc.sweep()).toEqual({ probed: 1, removed: 1, refused: 0, failed: 0 });

      await seed(root, 'stuck', { ended: true, ageMs: OLD, archives: 1 });
      const directory = join(root, 'journals', 'claude');
      await chmod(directory, 0o500);
      now += JOURNAL_SWEEP_INTERVAL_MS;
      try {
        expect(await gc.sweep()).toEqual({ probed: 1, removed: 0, refused: 0, failed: 1 });
      } finally {
        await chmod(directory, 0o700);
      }
      expect(await exists(journalPath(root, 'stuck'))).toBe(true);
      now += JOURNAL_SWEEP_INTERVAL_MS;
      expect(await gc.sweep()).toEqual({ probed: 0, removed: 1, refused: 0, failed: 0 });
      expect(await exists(journalPath(root, 'stuck', '.1'))).toBe(false);
    },
  );

  it('keeps every suffix of a journal that grows between being read and being removed', async () => {
    const root = await appData();
    await seed(root, 'resumed', { ended: true, ageMs: OLD, archives: 2 });
    let woke = false;
    const gc = collector(root, {
      fs: {
        lstat: async (path) => {
          // The session resumes while the sweep is about to remove its oldest archive.
          if (!woke && path.endsWith('.jsonl.2')) {
            woke = true;
            await appendFile(journalPath(root, 'resumed'), record('resumed', 'SessionStart'));
          }
          return lstat(path);
        },
        unlink,
      },
    });
    expect(await gc.sweep()).toEqual({ probed: 1, removed: 0, refused: 0, failed: 0 });
    for (const suffix of ['', '.1', '.2']) {
      expect(await exists(journalPath(root, 'resumed', suffix))).toBe(true);
    }
  });

  it('walks an oversized directory in windows that continue where the last stopped', () => {
    const small = new Set(['b', 'a']);
    expect(journalWindow(small, undefined)).toEqual(['b', 'a']);
    const names = Array.from(
      { length: MAX_JOURNAL_ENTRIES + 3 },
      (_, index) => `n${String(index).padStart(5, '0')}`,
    );
    const present = new Set(names.slice().reverse());
    const first = journalWindow(present, undefined);
    expect(first).toEqual(names.slice(0, MAX_JOURNAL_ENTRIES));
    const second = journalWindow(present, first[first.length - 1]);
    expect(second).toHaveLength(MAX_JOURNAL_ENTRIES);
    expect(second.slice(0, 3)).toEqual(names.slice(MAX_JOURNAL_ENTRIES));
    expect(second[3]).toBe(names[0]);
    // A remembered name that vanished starts the walk over.
    expect(journalWindow(present, 'zzz')[0]).toBe(names[0]);
  });
});

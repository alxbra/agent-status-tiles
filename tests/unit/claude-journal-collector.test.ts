import { access, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeJournalCollector,
  JOURNAL_RETENTION_MS,
  JOURNAL_SWEEP_INTERVAL_MS,
  MAX_SWEEP_PROBES,
  retainedClaudeJournals,
  type ClaudeJournalCollectorOptions,
} from '../../src/main/providers/claude/journal-collector';
import { makeHookJournalBaseName } from '../../src/main/providers/hooks/hook-journal-reader';
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
    expect(JSON.stringify(sweep)).not.toContain(root);
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

  it('keeps journals the monitors or the coordinator still refer to', async () => {
    const root = await appData();
    await seed(root, 'in-cohort', { ended: true, ageMs: OLD });
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
    const retained = retainedClaudeJournals(state);
    expect(retained).toEqual(new Set([baseName('with-cursor'), baseName('with-session')]));
    retained.add(baseName('in-cohort'));

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

    const sweep = await collector(root).sweep();
    expect(sweep).toEqual({ probed: 2, removed: 0, refused: 2, failed: 0 });
    expect(await exists(outside)).toBe(true);
    expect(await exists(journalPath(root, 'linked-archive'))).toBe(true);
    expect(await exists(journalPath(root, 'linked-archive', '.2'))).toBe(true);
    expect(await exists(journalPath(root, 'linked-active'))).toBe(true);
    expect(await exists(journalPath(root, 'dir-archive'))).toBe(true);

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
});

import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeJournalDiscovery,
  MAX_INSPECTED_JOURNALS,
  selectCohort,
  surfaceForIdentity,
} from '../../src/main/providers/claude/journal-discovery';
import { makeHookJournalBaseName } from '../../src/main/providers/hooks/hook-journal-reader';
import { RECENT_THREAD_DISCOVERY_WINDOW } from '../../src/shared/settings';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-discovery-'));
  roots.push(root);
  await mkdir(join(root, 'journals', 'claude'), { recursive: true, mode: 0o700 });
  return root;
}

function record(sessionId: string, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    schema_version: 1,
    provider: 'claude',
    event_name: 'SessionStart',
    session_id: sessionId,
    timestamp: 1_700_000_000_000,
    project_name: 'project',
    ...overrides,
  })}\n`;
}

function journalPath(root: string, sessionId: string): string {
  return join(root, 'journals', 'claude', `${makeHookJournalBaseName('claude', sessionId)}.jsonl`);
}

describe('claude journal discovery', () => {
  it('summarises verified journals with surface, host, title, and end state', async () => {
    const root = await appData();
    await writeFile(
      journalPath(root, 'desk'),
      record('desk', { host: 'claude-desktop', entrypoint: 'claude-desktop' }) +
        record('desk', { event_name: 'Stop', project_name: 'renamed' }),
    );
    await writeFile(journalPath(root, 'term'), record('term', { host: 'ghostty' }));
    await writeFile(
      journalPath(root, 'ended'),
      record('ended', { host: 'terminal' }) + record('ended', { event_name: 'SessionEnd' }),
    );
    await writeFile(journalPath(root, 'unknown'), record('unknown', { project_name: undefined }));
    // A file whose name does not hash its session ID is not ours.
    await writeFile(
      join(root, 'journals', 'claude', `${'a'.repeat(64)}.jsonl`),
      record('forged', { host: 'claude-desktop' }),
    );
    // Wrong provider, empty, malformed, symlinked, and oddly named files are skipped.
    await writeFile(journalPath(root, 'codex-ish'), record('codex-ish', { provider: 'codex' }));
    await writeFile(journalPath(root, 'empty'), '');
    await writeFile(journalPath(root, 'broken'), '{not json\n');
    await symlink(
      journalPath(root, 'term'),
      join(root, 'journals', 'claude', `${'b'.repeat(64)}.jsonl`),
    );
    await writeFile(join(root, 'journals', 'claude', 'notes.txt'), 'ignored');

    const summaries = await new ClaudeJournalDiscovery({ appDataPath: root }).list();
    const byId = Object.fromEntries(summaries.map((summary) => [summary.nativeSessionId, summary]));
    expect(Object.keys(byId).sort()).toEqual(['desk', 'ended', 'term', 'unknown']);
    expect(byId.desk).toMatchObject({
      surface: 'desktop',
      host: 'claude-desktop',
      projectName: 'renamed',
      ended: false,
      baseName: makeHookJournalBaseName('claude', 'desk'),
    });
    expect(byId.desk!.endOffset).toBeGreaterThan(0);
    expect(byId.term).toMatchObject({ surface: 'cli', host: 'ghostty', ended: false });
    expect(byId.ended).toMatchObject({ surface: 'cli', host: 'terminal', ended: true });
    expect(byId.unknown).toMatchObject({ surface: 'cli', ended: false });
    expect(byId.unknown).not.toHaveProperty('host');
    expect(byId.unknown).not.toHaveProperty('projectName');
    expect(JSON.stringify(summaries)).not.toContain('journals/');
  });

  it('returns nothing for a missing directory and refreshes a changed journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-none-'));
    roots.push(root);
    const discovery = new ClaudeJournalDiscovery({ appDataPath: root });
    expect(await discovery.list()).toEqual([]);

    await mkdir(join(root, 'journals', 'claude'), { recursive: true, mode: 0o700 });
    await writeFile(journalPath(root, 'live'), record('live', { host: 'warp' }));
    expect((await discovery.list())[0]).toMatchObject({ ended: false, surface: 'cli' });
    await appendFile(journalPath(root, 'live'), record('live', { event_name: 'SessionEnd' }));
    expect((await discovery.list())[0]).toMatchObject({ ended: true });
  });

  it('selects the newest journals per surface within the shared window', () => {
    const summaries = Array.from({ length: MAX_INSPECTED_JOURNALS }, (_, index) => ({
      baseName: `b${index}`,
      nativeSessionId: `s${index}`,
      surface: index % 2 === 0 ? ('desktop' as const) : ('cli' as const),
      ended: index === 2,
      updatedAt: 1_000 - index,
      endOffset: 1,
    }));
    const desktop = selectCohort(summaries, 'desktop');
    expect(desktop).toHaveLength(RECENT_THREAD_DISCOVERY_WINDOW);
    expect(desktop.map((summary) => summary.nativeSessionId)).not.toContain('s2');
    expect(desktop[0]!.nativeSessionId).toBe('s0');
    expect(selectCohort(summaries, 'cli').every((summary) => summary.surface === 'cli')).toBe(true);
  });

  it('attributes desktop from either identity variable and cli otherwise', () => {
    expect(surfaceForIdentity('claude-desktop', undefined)).toBe('desktop');
    expect(surfaceForIdentity(undefined, 'claude-desktop')).toBe('desktop');
    expect(surfaceForIdentity('terminal', 'cli')).toBe('cli');
    expect(surfaceForIdentity(undefined, undefined)).toBe('cli');
  });

  it('reads the tail separately for long journals and skips an oversized first line', async () => {
    const root = await appData();
    const filler = Array.from({ length: 140 }, (_, index) =>
      record('long', {
        event_name: 'PostToolUse',
        host: 'terminal',
        project_name: 'first',
      }).replace('"timestamp":1700000000000', `"timestamp":${1_700_000_000_000 + index}`),
    ).join('');
    const long =
      record('long', { host: 'terminal', project_name: 'first' }) +
      filler +
      record('long', { event_name: 'Stop', host: 'claude-desktop', project_name: 'last' });
    expect(Buffer.byteLength(long)).toBeGreaterThan(16 * 1024);
    await writeFile(journalPath(root, 'long'), long);
    await writeFile(
      journalPath(root, 'wide'),
      `${JSON.stringify({
        schema_version: 1,
        provider: 'claude',
        event_name: 'SessionStart',
        session_id: 'wide',
        timestamp: 1,
        project_name: 'x'.repeat(9 * 1024),
      })}\n`,
    );

    const summaries = await new ClaudeJournalDiscovery({ appDataPath: root }).list();
    expect(summaries.map((summary) => summary.nativeSessionId)).toEqual(['long']);
    expect(summaries[0]).toMatchObject({
      surface: 'desktop',
      host: 'claude-desktop',
      projectName: 'last',
      ended: false,
    });
  });

  it('inspects only the newest journals, breaking modification-time ties by name', async () => {
    const root = await appData();
    const total = MAX_INSPECTED_JOURNALS + 6;
    for (let index = 0; index < total; index += 1) {
      const id = `session-${String(index).padStart(3, '0')}`;
      await writeFile(journalPath(root, id), record(id, { host: 'terminal' }));
      const stamp = new Date(1_700_000_000_000 + (index < 2 ? 0 : index) * 1_000);
      await utimes(journalPath(root, id), stamp, stamp);
    }
    const summaries = await new ClaudeJournalDiscovery({ appDataPath: root }).list();
    expect(summaries).toHaveLength(MAX_INSPECTED_JOURNALS);
    const ids = summaries.map((summary) => summary.nativeSessionId);
    // The six oldest (indices 0-5) are excluded; 0 and 1 tie and both fall out.
    expect(ids).not.toContain('session-000');
    expect(ids).not.toContain('session-005');
    expect(ids[0]).toBe(`session-${String(total - 1).padStart(3, '0')}`);

    const tied = await appData();
    for (const id of ['tie-b', 'tie-a']) {
      await writeFile(journalPath(tied, id), record(id, { host: 'terminal' }));
      await utimes(journalPath(tied, id), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    }
    const names = (await new ClaudeJournalDiscovery({ appDataPath: tied }).list()).map(
      (summary) => summary.baseName,
    );
    expect(names).toEqual([...names].sort());
  });

  it('keeps a session through a helper rotation instead of treating it as ended', async () => {
    const root = await appData();
    const discovery = new ClaudeJournalDiscovery({ appDataPath: root });
    await writeFile(journalPath(root, 'rot'), record('rot', { host: 'warp' }));
    expect((await discovery.list()).map((summary) => summary.nativeSessionId)).toEqual(['rot']);

    // Rotation renames the active file away first, then recreates it empty.
    await rename(journalPath(root, 'rot'), `${journalPath(root, 'rot')}.1`);
    expect((await discovery.list()).map((summary) => summary.nativeSessionId)).toEqual(['rot']);
    await writeFile(journalPath(root, 'rot'), '');
    expect((await discovery.list()).map((summary) => summary.nativeSessionId)).toEqual(['rot']);

    // Without an archive an empty or missing active file is simply gone.
    await rm(`${journalPath(root, 'rot')}.1`);
    expect(await discovery.list()).toEqual([]);
    await rm(journalPath(root, 'rot'));
    expect(await discovery.list()).toEqual([]);
  });
});

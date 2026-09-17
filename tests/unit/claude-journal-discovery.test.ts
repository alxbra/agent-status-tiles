import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

export function record(sessionId: string, overrides: Record<string, unknown> = {}): string {
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
});

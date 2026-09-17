import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeSessionNames } from '../../src/main/providers/claude/session-names';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-names-'));
  roots.push(root);
  await mkdir(join(root, 'sessions'), { recursive: true });
  return root;
}

describe('claude session names', () => {
  it('maps session IDs to the names Claude recorded and ignores everything else', async () => {
    const directory = await configDirectory();
    const sessions = join(directory, 'sessions');
    await writeFile(
      join(sessions, '100.json'),
      JSON.stringify({
        pid: 100,
        sessionId: 'aaaa-1',
        name: 'Add journal garbage collection',
        cwd: '/Users/private/project',
        entrypoint: 'claude-desktop',
      }),
    );
    await writeFile(join(sessions, '101.json'), JSON.stringify({ sessionId: 'bbbb-2' }));
    await writeFile(join(sessions, '102.json'), JSON.stringify({ sessionId: 'cccc-3', name: '' }));
    await writeFile(
      join(sessions, '103.json'),
      JSON.stringify({ sessionId: 'dddd-4', name: 'x'.repeat(300) }),
    );
    await writeFile(
      join(sessions, '104.json'),
      JSON.stringify({ sessionId: 'eeee-5', name: `bad${String.fromCharCode(7)}name` }),
    );
    await writeFile(join(sessions, '105.json'), '{not json');
    await writeFile(join(sessions, '106.json'), JSON.stringify(['array']));
    await writeFile(
      join(sessions, 'notes.txt'),
      JSON.stringify({ sessionId: 'ffff-6', name: 'ignored' }),
    );
    await writeFile(join(sessions, '107.json.key'), 'secret');
    await symlink(join(sessions, '100.json'), join(sessions, '108.json'));

    const names = await new ClaudeSessionNames({ configDirectory: directory }).lookup();
    expect([...names.entries()]).toEqual([['aaaa-1', 'Add journal garbage collection']]);
  });

  it('returns nothing without a registry and refreshes changed files', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-names-none-'));
    roots.push(missing);
    expect((await new ClaudeSessionNames({ configDirectory: missing }).lookup()).size).toBe(0);

    const directory = await configDirectory();
    const file = join(directory, 'sessions', '200.json');
    const names = new ClaudeSessionNames({ configDirectory: directory });
    await writeFile(file, JSON.stringify({ sessionId: 's', name: 'first' }));
    expect((await names.lookup()).get('s')).toBe('first');
    await writeFile(file, JSON.stringify({ sessionId: 's', name: 'renamed thread' }));
    expect((await names.lookup()).get('s')).toBe('renamed thread');
    await chmod(file, 0o000);
    try {
      expect((await names.lookup()).get('s')).toBeUndefined();
    } finally {
      await chmod(file, 0o600);
    }
  });
});

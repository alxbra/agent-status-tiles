import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const openHook = vi.hoisted(() => ({
  current: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (
      path: Parameters<typeof actual.open>[0],
      flags?: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2],
    ) => {
      if (openHook.current !== undefined) await openHook.current(String(path));
      return actual.open(path, flags, mode);
    },
  };
});

import {
  CLAUDE_HOOK_EVENTS,
  claudeSettingsPath,
  formatOwnedHookCommand,
  inspectClaudeHooks,
  installClaudeHooks,
  parseOwnedHookCommand,
  planClaudeHookRemoval,
  removeClaudeHooks,
  verifyClaudeHooks,
} from '../../src/main/providers/claude/hook-installer';

const roots: string[] = [];

afterEach(async () => {
  openHook.current = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-hooks-'));
  roots.push(root);
  const directory = join(root, '.claude');
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

const helperPath =
  '/Applications/Agent Status Tiles.app/Contents/Resources/hook-helper/arm64/hook-helper';
const dataDirectory = '/Users/example/Library/Application Support/agent-status-tiles';
const command = { helperPath, dataDirectory };

async function readSettings(directory: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(claudeSettingsPath(directory), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('claude hook installer', () => {
  it('formats a shell-safe owned command and recognises only that shape', () => {
    const formatted = formatOwnedHookCommand(command);
    expect(formatted).toBe(`'${helperPath}' --provider claude --data-dir '${dataDirectory}'`);
    expect(parseOwnedHookCommand(formatted)).toEqual(command);

    const quoted = { helperPath: "/Volumes/it's here/hook-helper", dataDirectory: "/tmp/o'k" };
    expect(parseOwnedHookCommand(formatOwnedHookCommand(quoted))).toEqual(quoted);

    for (const other of [
      undefined,
      42,
      'echo hi',
      `'/usr/bin/other' --provider claude --data-dir '${dataDirectory}'`,
      `'${helperPath}' --provider codex --data-dir '${dataDirectory}'`,
      `'relative/hook-helper' --provider claude --data-dir '${dataDirectory}'`,
      `'${helperPath}' --provider claude --data-dir '${dataDirectory}'; rm -rf /`,
    ]) {
      expect(parseOwnedHookCommand(other)).toBeUndefined();
    }
  });

  it('installs one owned entry per event into a fresh directory and is idempotent', async () => {
    const directory = await configDirectory();
    expect(await inspectClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      status: 'missing',
    });
    expect(await installClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      changed: true,
    });
    const settings = await readSettings(directory);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toEqual([...CLAUDE_HOOK_EVENTS]);
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(hooks[event]).toEqual([
        {
          hooks: [
            {
              type: 'command',
              command: formatOwnedHookCommand(command),
              timeout: 5,
              async: true,
            },
          ],
        },
      ]);
    }
    expect(await inspectClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      status: 'installed',
    });
    // A file this app creates is private to the user.
    expect((await stat(claudeSettingsPath(directory))).mode & 0o777).toBe(0o600);

    const before = await readFile(claudeSettingsPath(directory), 'utf8');
    expect(await installClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      changed: false,
    });
    expect(await readFile(claudeSettingsPath(directory), 'utf8')).toBe(before);
    expect(before.endsWith('\n')).toBe(true);
  });

  it('preserves unrelated settings and hooks, replaces stale owned entries, and removes only its own', async () => {
    const directory = await configDirectory();
    const stale = formatOwnedHookCommand({ helperPath: '/old/path/hook-helper', dataDirectory });
    const original = {
      theme: 'dark',
      hooks: {
        Stop: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] },
          { hooks: [{ type: 'command', command: stale, timeout: 5 }] },
        ],
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [
              { type: 'command', command: 'lint --fix' },
              { type: 'command', command: stale },
            ],
          },
        ],
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo keep' }] }],
      },
      permissions: { allow: ['Bash(ls)'] },
    };
    await writeFile(claudeSettingsPath(directory), JSON.stringify(original, null, 2));
    expect(await inspectClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      status: 'stale',
    });

    await installClaudeHooks({ configDirectory: directory, ...command });
    const installed = await readSettings(directory);
    expect(Object.keys(installed)).toEqual(['theme', 'hooks', 'permissions']);
    expect(installed.permissions).toEqual(original.permissions);
    const hooks = installed.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toEqual([
      'Stop',
      'PreToolUse',
      'PreCompact',
      ...CLAUDE_HOOK_EVENTS.filter((event) => !['Stop', 'PreToolUse'].includes(event)),
    ]);
    expect(hooks.Stop).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] },
      {
        hooks: [
          { type: 'command', command: formatOwnedHookCommand(command), timeout: 5, async: true },
        ],
      },
    ]);
    expect(hooks.PreToolUse).toEqual([
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'lint --fix' }] },
      {
        hooks: [
          { type: 'command', command: formatOwnedHookCommand(command), timeout: 5, async: true },
        ],
      },
    ]);
    expect(hooks.PreCompact).toEqual(original.hooks.PreCompact);
    expect(JSON.stringify(installed)).not.toContain('/old/path');

    expect(await removeClaudeHooks({ configDirectory: directory })).toEqual({ changed: true });
    const removed = await readSettings(directory);
    expect(removed).toEqual({
      theme: 'dark',
      hooks: {
        Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint --fix' }] }],
        PreCompact: original.hooks.PreCompact,
      },
      permissions: original.permissions,
    });
    expect(await removeClaudeHooks({ configDirectory: directory })).toEqual({ changed: false });
  });

  it('leaves a user-only file untouched even when hooks is not the last key', async () => {
    const directory = await configDirectory();
    const content = `{\n  "hooks": {\n    "Stop": [{ "hooks": [{ "type": "command", "command": "echo mine" }] }]\n  },\n  "theme": "light"\n}\n`;
    await writeFile(claudeSettingsPath(directory), content);
    expect(await removeClaudeHooks({ configDirectory: directory })).toEqual({ changed: false });
    expect(await readFile(claudeSettingsPath(directory), 'utf8')).toBe(content);

    // Install keeps `hooks` in its original position too.
    await installClaudeHooks({ configDirectory: directory, ...command });
    expect(Object.keys(await readSettings(directory))).toEqual(['hooks', 'theme']);
  });

  it('passes through groups it does not understand and consolidates duplicate owned entries', async () => {
    const directory = await configDirectory();
    const ownedEntry = {
      type: 'command',
      command: formatOwnedHookCommand(command),
      timeout: 5,
      async: true,
    };
    const odd = [
      { hooks: 'not-an-array' },
      'not-a-group',
      { matcher: 'x', hooks: [ownedEntry, ownedEntry] },
    ];
    await writeFile(
      claudeSettingsPath(directory),
      JSON.stringify({ hooks: { Stop: odd, PreToolUse: [{ hooks: [ownedEntry, ownedEntry] }] } }),
    );
    expect(await inspectClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      status: 'stale',
    });
    await installClaudeHooks({ configDirectory: directory, ...command });
    const hooks = (await readSettings(directory)).hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toEqual([{ hooks: 'not-an-array' }, 'not-a-group', { hooks: [ownedEntry] }]);
    expect(hooks.PreToolUse).toEqual([{ hooks: [ownedEntry] }]);
    expect(await inspectClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      status: 'installed',
    });
  });

  it('drops the hooks object entirely when nothing else remains', () => {
    const settings = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: formatOwnedHookCommand(command) }] }] },
      theme: 'light',
    };
    expect(planClaudeHookRemoval(settings)).toEqual({ theme: 'light' });
    expect(planClaudeHookRemoval({ theme: 'light' })).toEqual({ theme: 'light' });
  });

  it('reports disabled hooks and stale partial installs', () => {
    const owned = {
      hooks: [
        { type: 'command', command: formatOwnedHookCommand(command), timeout: 5, async: true },
      ],
    };
    const complete = Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [owned]]));
    expect(verifyClaudeHooks({ hooks: complete }, command)).toEqual({ status: 'installed' });
    expect(verifyClaudeHooks({ hooks: complete, disableAllHooks: true }, command)).toEqual({
      status: 'disabled',
    });
    expect(verifyClaudeHooks({ hooks: { Stop: [owned] } }, command)).toEqual({ status: 'stale' });
    // A matcher would filter callbacks and a changed field changes behaviour.
    const scoped = { matcher: 'Bash', hooks: owned.hooks };
    expect(verifyClaudeHooks({ hooks: { ...complete, Stop: [scoped] } }, command)).toEqual({
      status: 'stale',
    });
    const sync = { hooks: [{ ...owned.hooks[0], async: false }] };
    expect(verifyClaudeHooks({ hooks: { ...complete, Stop: [sync] } }, command)).toEqual({
      status: 'stale',
    });
    const extra = { hooks: [{ ...owned.hooks[0], statusMessage: 'x' }] };
    expect(verifyClaudeHooks({ hooks: { ...complete, Stop: [extra] } }, command)).toEqual({
      status: 'stale',
    });
    expect(verifyClaudeHooks({ hooks: { ...complete, Stop: [owned, owned] } }, command)).toEqual({
      status: 'stale',
    });
    expect(verifyClaudeHooks({}, command)).toEqual({ status: 'missing' });
    expect(verifyClaudeHooks({ hooks: 'nope' }, command)).toEqual({
      status: 'unreadable',
      code: 'hooks-unsupported',
    });
  });

  it('leaves a complete but disabled install untouched', async () => {
    const directory = await configDirectory();
    await installClaudeHooks({ configDirectory: directory, ...command });
    const settings = await readSettings(directory);
    await writeFile(
      claudeSettingsPath(directory),
      JSON.stringify({ ...settings, disableAllHooks: true }, null, 2),
    );
    const before = await readFile(claudeSettingsPath(directory), 'utf8');
    expect(await inspectClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      status: 'disabled',
    });
    expect(await installClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      changed: false,
    });
    expect(await readFile(claudeSettingsPath(directory), 'utf8')).toBe(before);
  });

  it('never replaces a dangling settings symlink', async () => {
    const directory = await configDirectory();
    const missingTarget = join(directory, '..', 'dotfiles', 'gone.json');
    await symlink(missingTarget, claudeSettingsPath(directory));
    await expect(
      installClaudeHooks({ configDirectory: directory, ...command }),
    ).rejects.toMatchObject({ code: 'settings-unreadable' });
    expect(await inspectClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      status: 'unreadable',
      code: 'settings-unreadable',
    });
    await expect(removeClaudeHooks({ configDirectory: directory })).rejects.toMatchObject({
      code: 'settings-unreadable',
    });
    expect((await lstat(claudeSettingsPath(directory))).isSymbolicLink()).toBe(true);
    await expect(readFile(claudeSettingsPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes through a symlinked settings file and keeps its mode', async () => {
    const directory = await configDirectory();
    const dotfiles = join(directory, '..', 'dotfiles');
    await mkdir(dotfiles);
    const target = join(dotfiles, 'claude-settings.json');
    await writeFile(target, '{"theme":"dark"}\n');
    await chmod(target, 0o640);
    await symlink(target, claudeSettingsPath(directory));

    await installClaudeHooks({ configDirectory: directory, ...command });

    expect(await realpath(claudeSettingsPath(directory))).toBe(await realpath(target));
    const written = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(written.theme).toBe('dark');
    expect(Object.keys(written.hooks as object)).toHaveLength(CLAUDE_HOOK_EVENTS.length);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(await readdir(dotfiles)).toEqual(['claude-settings.json']);
  });

  it('keeps a permissive mode regardless of the umask and leaves no temp file behind', async () => {
    const directory = await configDirectory();
    await writeFile(claudeSettingsPath(directory), '{}\n');
    await chmod(claudeSettingsPath(directory), 0o666);
    // A restrictive umask would strip group and other bits from a plain open.
    const previousUmask = process.umask(0o077);
    try {
      await installClaudeHooks({ configDirectory: directory, ...command });
    } finally {
      process.umask(previousUmask);
    }
    expect((await stat(claudeSettingsPath(directory))).mode & 0o777).toBe(0o666);
    expect(await readdir(directory)).toEqual(['settings.json']);

    // A write failure (read-only directory) must not leave a temporary file either.
    await chmod(directory, 0o500);
    try {
      await expect(removeClaudeHooks({ configDirectory: directory })).rejects.toMatchObject({
        code: 'settings-unwritable',
      });
    } finally {
      await chmod(directory, 0o700);
    }
    expect(await readdir(directory)).toEqual(['settings.json']);
  });

  it('aborts without writing when the file changes between the read and the write', async () => {
    const directory = await configDirectory();
    const path = claudeSettingsPath(directory);
    await writeFile(path, '{"theme":"dark"}\n');
    // Claude Code writes the file while the plan is being computed: the
    // temporary file is opened after the read, so change the target then.
    openHook.current = async (opened) => {
      if (opened.includes('.tmp')) {
        openHook.current = undefined;
        // Same length and same inode as before: only the timestamps differ.
        await writeFile(path, '{"theme":"blue"}\n');
      }
    };
    await expect(
      installClaudeHooks({ configDirectory: directory, ...command }),
    ).rejects.toMatchObject({ code: 'settings-changed' });
    expect(await readFile(path, 'utf8')).toBe('{"theme":"blue"}\n');
    expect(await readdir(directory)).toEqual(['settings.json']);

    // The next attempt sees the new content and installs on top of it.
    await installClaudeHooks({ configDirectory: directory, ...command });
    expect((await readSettings(directory)).theme).toBe('blue');
  });

  it('reports a non-file at the settings path instead of rewriting it', async () => {
    const directory = await configDirectory();
    execFileSync('mkfifo', [claudeSettingsPath(directory)]);
    expect(await inspectClaudeHooks({ configDirectory: directory, ...command })).toEqual({
      status: 'unreadable',
      code: 'settings-unreadable',
    });
    await expect(
      installClaudeHooks({ configDirectory: directory, ...command }),
    ).rejects.toMatchObject({ code: 'settings-unreadable' });
    expect((await lstat(claudeSettingsPath(directory))).isFIFO()).toBe(true);
  });

  it('keeps a literal __proto__ key as data on install and removal', async () => {
    const directory = await configDirectory();
    const content =
      '{"__proto__":{"x":1},"theme":"dark","hooks":{"__proto__":[{"hooks":[{"type":"command","command":"echo keep"}]}]}}\n';
    await writeFile(claudeSettingsPath(directory), content);
    expect(await removeClaudeHooks({ configDirectory: directory })).toEqual({ changed: false });
    expect(await readFile(claudeSettingsPath(directory), 'utf8')).toBe(content);
    await installClaudeHooks({ configDirectory: directory, ...command });
    const raw = await readFile(claudeSettingsPath(directory), 'utf8');
    expect(raw).toContain('"__proto__": {\n    "x": 1');
    expect(raw).toContain('echo keep');
    await removeClaudeHooks({ configDirectory: directory });
    expect(JSON.parse(await readFile(claudeSettingsPath(directory), 'utf8'))).toEqual(
      JSON.parse(content),
    );
  });

  it('never rewrites a file it cannot parse or that is not a JSON object', async () => {
    const directory = await configDirectory();
    for (const content of ['{ not json', '[]', '"text"', '42']) {
      await writeFile(claudeSettingsPath(directory), content);
      await expect(
        installClaudeHooks({ configDirectory: directory, ...command }),
      ).rejects.toMatchObject({
        code: content === '{ not json' ? 'settings-not-json' : 'settings-not-object',
      });
      expect(await readFile(claudeSettingsPath(directory), 'utf8')).toBe(content);
      expect(await inspectClaudeHooks({ configDirectory: directory, ...command })).toMatchObject({
        status: 'unreadable',
      });
    }
    await writeFile(claudeSettingsPath(directory), '{"hooks": {"Stop": "oops"}}');
    await expect(
      installClaudeHooks({ configDirectory: directory, ...command }),
    ).rejects.toMatchObject({ code: 'hooks-unsupported' });
    await expect(removeClaudeHooks({ configDirectory: directory })).rejects.toMatchObject({
      code: 'hooks-unsupported',
    });
  });

  it('treats an empty file like a missing one and rejects relative paths', async () => {
    const directory = await configDirectory();
    await writeFile(claudeSettingsPath(directory), '\n');
    await installClaudeHooks({ configDirectory: directory, ...command });
    expect(Object.keys((await readSettings(directory)).hooks as object)).toHaveLength(
      CLAUDE_HOOK_EVENTS.length,
    );
    await expect(
      installClaudeHooks({ configDirectory: directory, helperPath: 'hook-helper', dataDirectory }),
    ).rejects.toThrow('absolute');
  });
});

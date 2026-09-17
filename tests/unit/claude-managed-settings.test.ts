import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_MANAGED_DIRECTORY,
  MAX_MANAGED_DROP_INS,
  defaultClaudeManagedLocations,
  inspectClaudeManagedHooks,
  type ClaudeManagedHookSetting,
  type ClaudeManagedLocations,
} from '../../src/main/providers/claude/managed-settings';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ManagedFixture extends ClaudeManagedLocations {
  root: string;
  dropIns: string;
}

async function locations(): Promise<ManagedFixture> {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-managed-'));
  roots.push(root);
  const directory = join(root, 'ClaudeCode');
  return { root, directory, dropIns: join(directory, 'managed-settings.d'), preferencesPaths: [] };
}

async function writeManaged(directory: string, name: string, content: unknown): Promise<void> {
  const path = join(directory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
}

/** Write the main file and drop-ins in one call; drop-in names sort in the given order. */
async function writeSequence(
  managed: ManagedFixture,
  main: unknown | undefined,
  dropIns: readonly unknown[],
): Promise<void> {
  await rm(managed.directory, { recursive: true, force: true });
  if (main !== undefined) await writeManaged(managed.directory, 'managed-settings.json', main);
  for (const [index, content] of dropIns.entries()) {
    await writeManaged(managed.dropIns, `${String(index).padStart(2, '0')}.json`, content);
  }
}

const restricted = (setting: ClaudeManagedHookSetting) => ({ status: 'restricted', setting });
const unrestricted = { status: 'unrestricted' };
const unknown = { status: 'unknown' };

describe('claude managed settings', () => {
  it('points at the macOS system directory and the MDM domain by default', () => {
    const defaults = defaultClaudeManagedLocations();
    expect(defaults.directory).toBe(CLAUDE_MANAGED_DIRECTORY);
    expect(CLAUDE_MANAGED_DIRECTORY).toBe('/Library/Application Support/ClaudeCode');
    expect(defaults.preferencesPaths[0]).toBe(
      '/Library/Managed Preferences/com.anthropic.claudecode.plist',
    );
    for (const path of defaults.preferencesPaths) {
      expect(path).toMatch(
        /^\/Library\/Managed Preferences\/.*com\.anthropic\.claudecode\.plist$/u,
      );
    }
  });

  it('reports no restriction when nothing managed exists or the keys are off', async () => {
    const managed = await locations();
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
    await writeManaged(managed.directory, 'managed-settings.json', {
      disableAllHooks: false,
      allowManagedHooksOnly: false,
      strictPluginOnlyCustomization: ['skills', 'agents'],
      permissions: { deny: ['Bash(rm:*)'] },
    });
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
    // An empty file is a missing policy, not a broken one.
    await writeManaged(managed.directory, 'managed-settings.json', '\n');
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
  });

  it('names the managed key that keeps user hooks from running', async () => {
    const managed = await locations();
    const cases: [unknown, ClaudeManagedHookSetting][] = [
      [{ disableAllHooks: true }, 'disableAllHooks'],
      [{ allowManagedHooksOnly: true }, 'allowManagedHooksOnly'],
      // Claude Code treats an invalid value as true until it is fixed.
      [{ allowManagedHooksOnly: 'yes' }, 'allowManagedHooksOnly'],
      [{ allowManagedHooksOnly: null }, 'allowManagedHooksOnly'],
      [{ strictPluginOnlyCustomization: true }, 'strictPluginOnlyCustomization'],
      [{ strictPluginOnlyCustomization: ['mcp', 'hooks'] }, 'strictPluginOnlyCustomization'],
      // The most sweeping key names the reason when several apply.
      [{ allowManagedHooksOnly: true, disableAllHooks: true }, 'disableAllHooks'],
    ];
    for (const [content, setting] of cases) {
      await writeManaged(managed.directory, 'managed-settings.json', content);
      expect(await inspectClaudeManagedHooks(managed)).toEqual(restricted(setting));
    }
    // Only a literal true disables; anything else leaves hooks on.
    for (const value of [null, 'true', 1]) {
      await writeManaged(managed.directory, 'managed-settings.json', { disableAllHooks: value });
      expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
    }
  });

  it('lets a later single value replace an earlier one across the main file and drop-ins', async () => {
    const managed = await locations();
    await writeSequence(managed, { disableAllHooks: true }, [{ disableAllHooks: false }]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
    await writeSequence(managed, { disableAllHooks: false }, [
      { disableAllHooks: true },
      { disableAllHooks: false },
      { disableAllHooks: true },
    ]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(restricted('disableAllHooks'));
    // A later false lifts an accumulated lock; a later value that is not a
    // documented one replaces it as well rather than raising an alarm.
    await writeSequence(managed, { strictPluginOnlyCustomization: true }, [
      { strictPluginOnlyCustomization: false },
    ]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
    await writeSequence(managed, { strictPluginOnlyCustomization: ['hooks'] }, [
      { strictPluginOnlyCustomization: false },
    ]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
    await writeSequence(managed, { strictPluginOnlyCustomization: true }, [
      { strictPluginOnlyCustomization: null },
    ]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
    // Drop-ins alone, without the main file, are still read.
    await writeSequence(managed, undefined, [{ allowManagedHooksOnly: true }]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(restricted('allowManagedHooksOnly'));
  });

  it('combines lists across files but lets a single value cut the chain', async () => {
    const managed = await locations();
    await writeSequence(managed, { strictPluginOnlyCustomization: ['hooks'] }, [
      { strictPluginOnlyCustomization: ['skills'] },
    ]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(
      restricted('strictPluginOnlyCustomization'),
    );
    await writeSequence(managed, { strictPluginOnlyCustomization: ['skills'] }, [
      { strictPluginOnlyCustomization: ['hooks'] },
    ]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(
      restricted('strictPluginOnlyCustomization'),
    );
    // An array after true names the locks anew, and an earlier list does not
    // survive the true in between.
    await writeSequence(managed, { strictPluginOnlyCustomization: true }, [
      { strictPluginOnlyCustomization: ['skills'] },
    ]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
    await writeSequence(managed, { strictPluginOnlyCustomization: ['hooks'] }, [
      { strictPluginOnlyCustomization: true },
      { strictPluginOnlyCustomization: ['skills'] },
    ]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
    await writeSequence(managed, { strictPluginOnlyCustomization: ['skills'] }, [
      { strictPluginOnlyCustomization: true },
    ]);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(
      restricted('strictPluginOnlyCustomization'),
    );
  });

  it('reads drop-ins in alphabetical order and ignores hidden and non-JSON entries', async () => {
    const managed = await locations();
    await writeSequence(managed, { disableAllHooks: false }, []);
    // Alphabetical, not creation order: the later name wins.
    await writeManaged(managed.dropIns, '20-on.json', { disableAllHooks: true });
    await writeManaged(managed.dropIns, '10-off.json', { disableAllHooks: false });
    expect(await inspectClaudeManagedHooks(managed)).toEqual(restricted('disableAllHooks'));
    await writeManaged(managed.dropIns, '30-off.json', { disableAllHooks: false });
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);

    // Positive control: this body flips the result when it is in a visible file.
    const lock = { strictPluginOnlyCustomization: ['hooks'] };
    await writeManaged(managed.dropIns, '40-lock.json', lock);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(
      restricted('strictPluginOnlyCustomization'),
    );
    await rm(join(managed.dropIns, '40-lock.json'));
    await writeManaged(managed.dropIns, '.hidden.json', lock);
    await writeManaged(managed.dropIns, 'notes.txt', JSON.stringify(lock));
    await writeManaged(managed.dropIns, 'README.json.bak', lock);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unrestricted);
  });

  it('answers unknown rather than guessing when the managed tier cannot be read', async () => {
    const managed = await locations();
    for (const content of ['{ not json', '[]', '"text"']) {
      await writeManaged(managed.directory, 'managed-settings.json', content);
      expect(await inspectClaudeManagedHooks(managed)).toEqual(unknown);
    }
    await writeSequence(managed, { disableAllHooks: false }, ['{']);
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unknown);

    // An unreadable drop-in directory hides an unknown number of files.
    await writeSequence(managed, { disableAllHooks: false }, []);
    await mkdir(managed.dropIns);
    await chmod(managed.dropIns, 0o000);
    try {
      expect(await inspectClaudeManagedHooks(managed)).toEqual(unknown);
    } finally {
      await chmod(managed.dropIns, 0o700);
    }
    await writeSequence(
      managed,
      { disableAllHooks: false },
      Array.from({ length: MAX_MANAGED_DROP_INS + 1 }, () => ({})),
    );
    expect(await inspectClaudeManagedHooks(managed)).toEqual(unknown);
  });

  it('defers to a present MDM profile instead of reading the files', async () => {
    const managed = await locations();
    await writeManaged(managed.directory, 'managed-settings.json', { disableAllHooks: true });
    const plist = join(managed.root, 'com.anthropic.claudecode.plist');
    const withProfile = {
      ...managed,
      preferencesPaths: [join(managed.root, 'absent.plist'), plist],
    };
    expect(await inspectClaudeManagedHooks(withProfile)).toEqual(restricted('disableAllHooks'));
    await writeFile(plist, 'not parsed');
    expect(await inspectClaudeManagedHooks(withProfile)).toEqual(unknown);

    // A profile that cannot even be stat'ed may still exist, so it counts as present.
    const locked = join(managed.root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      expect(
        await inspectClaudeManagedHooks({
          ...managed,
          preferencesPaths: [join(locked, 'com.anthropic.claudecode.plist')],
        }),
      ).toEqual(unknown);
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

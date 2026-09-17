import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_MANAGED_DIRECTORY,
  MAX_MANAGED_DROP_INS,
  defaultClaudeManagedLocations,
  inspectClaudeManagedHooks,
  type ClaudeManagedLocations,
} from '../../src/main/providers/claude/managed-settings';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function locations(): Promise<ClaudeManagedLocations & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-managed-'));
  roots.push(root);
  return { root, directory: join(root, 'ClaudeCode'), preferencesPaths: [] };
}

async function writeManaged(directory: string, name: string, content: unknown): Promise<void> {
  const path = join(directory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
}

describe('claude managed settings', () => {
  it('points at the macOS system directory and the MDM domain by default', () => {
    const defaults = defaultClaudeManagedLocations();
    expect(defaults.directory).toBe(CLAUDE_MANAGED_DIRECTORY);
    expect(defaults.directory).toBe('/Library/Application Support/ClaudeCode');
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
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unrestricted' });
    await writeManaged(managed.directory, 'managed-settings.json', {
      disableAllHooks: false,
      allowManagedHooksOnly: false,
      strictPluginOnlyCustomization: ['skills', 'agents'],
      permissions: { deny: ['Bash(rm:*)'] },
    });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unrestricted' });
    // An empty file is a missing policy, not a broken one.
    await writeManaged(managed.directory, 'managed-settings.json', '\n');
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unrestricted' });
  });

  it('names the managed key that keeps user hooks from running', async () => {
    const managed = await locations();
    const cases: [unknown, string][] = [
      [{ disableAllHooks: true }, 'disableAllHooks'],
      [{ allowManagedHooksOnly: true }, 'allowManagedHooksOnly'],
      // Claude Code treats an invalid value as true until it is fixed.
      [{ allowManagedHooksOnly: 'yes' }, 'allowManagedHooksOnly'],
      [{ strictPluginOnlyCustomization: true }, 'strictPluginOnlyCustomization'],
      [{ strictPluginOnlyCustomization: ['mcp', 'hooks'] }, 'strictPluginOnlyCustomization'],
      // The most sweeping key names the reason when several apply.
      [{ allowManagedHooksOnly: true, disableAllHooks: true }, 'disableAllHooks'],
    ];
    for (const [content, setting] of cases) {
      await writeManaged(managed.directory, 'managed-settings.json', content);
      expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'restricted', setting });
    }
  });

  it('merges drop-ins after the main file in alphabetical order, ignoring hidden and non-JSON files', async () => {
    const managed = await locations();
    const dropIns = join(managed.directory, 'managed-settings.d');
    await writeManaged(managed.directory, 'managed-settings.json', { disableAllHooks: true });
    await writeManaged(dropIns, '10-hooks.json', { disableAllHooks: false });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unrestricted' });

    await writeManaged(dropIns, '20-security.json', { disableAllHooks: true });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({
      status: 'restricted',
      setting: 'disableAllHooks',
    });
    await writeManaged(dropIns, '30-relax.json', { disableAllHooks: false });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unrestricted' });

    // Lists combine across files, so a lock named anywhere holds.
    await writeManaged(dropIns, '05-lock.json', { strictPluginOnlyCustomization: ['hooks'] });
    await writeManaged(dropIns, '40-other.json', { strictPluginOnlyCustomization: ['skills'] });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({
      status: 'restricted',
      setting: 'strictPluginOnlyCustomization',
    });

    // A later `false` replaces the accumulated lock; a later array locks again.
    await writeManaged(dropIns, '45-unlock.json', { strictPluginOnlyCustomization: false });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unrestricted' });
    await writeManaged(dropIns, '46-relock.json', { strictPluginOnlyCustomization: ['hooks'] });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({
      status: 'restricted',
      setting: 'strictPluginOnlyCustomization',
    });
    await writeManaged(managed.directory, 'managed-settings.json', {
      strictPluginOnlyCustomization: true,
    });
    await writeManaged(dropIns, '47-unlock-all.json', { strictPluginOnlyCustomization: false });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unrestricted' });
    // A later array replaces an earlier `true` and names the locks anew,
    // with no earlier list left to combine with.
    for (const name of ['05-lock', '45-unlock', '46-relock']) {
      await rm(join(dropIns, `${name}.json`));
    }
    await writeManaged(dropIns, '47-unlock-all.json', {
      strictPluginOnlyCustomization: ['skills'],
    });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unrestricted' });
    await writeManaged(dropIns, '48-lock-all.json', { strictPluginOnlyCustomization: true });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({
      status: 'restricted',
      setting: 'strictPluginOnlyCustomization',
    });
    await writeManaged(managed.directory, 'managed-settings.json', { disableAllHooks: true });
    await rm(join(dropIns, '47-unlock-all.json'));
    await rm(join(dropIns, '48-lock-all.json'));

    // Surviving files: managed-settings.json (true), 10 (false), 20 (true),
    // 30 (false), 40 (skills only); the result is unrestricted, and each
    // ignored file below would flip it to restricted if it were read, since
    // a named lock survives every later single-value replacement.
    await writeManaged(dropIns, '.hidden.json', { strictPluginOnlyCustomization: ['hooks'] });
    await writeManaged(dropIns, 'notes.txt', '{ "strictPluginOnlyCustomization": ["hooks"] }');
    await writeManaged(dropIns, 'README.json.bak', { strictPluginOnlyCustomization: ['hooks'] });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unrestricted' });

    // A drop-in directory alone, without the main file, is still read.
    await rm(join(managed.directory, 'managed-settings.json'));
    await writeManaged(dropIns, '50-hooks.json', { allowManagedHooksOnly: true });
    expect(await inspectClaudeManagedHooks(managed)).toEqual({
      status: 'restricted',
      setting: 'allowManagedHooksOnly',
    });
  });

  it('answers unknown rather than guessing when the managed tier cannot be read', async () => {
    const managed = await locations();
    for (const content of ['{ not json', '[]', '"text"']) {
      await writeManaged(managed.directory, 'managed-settings.json', content);
      expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unknown' });
    }
    await writeManaged(managed.directory, 'managed-settings.json', { disableAllHooks: false });
    await writeManaged(managed.directory, 'managed-settings.d/10-broken.json', '{');
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unknown' });
    await rm(join(managed.directory, 'managed-settings.d'), { recursive: true });

    // An unreadable drop-in directory hides an unknown number of files.
    const dropIns = join(managed.directory, 'managed-settings.d');
    await mkdir(dropIns);
    await chmod(dropIns, 0o000);
    try {
      expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unknown' });
    } finally {
      await chmod(dropIns, 0o700);
    }
    await Promise.all(
      Array.from({ length: MAX_MANAGED_DROP_INS + 1 }, (_, index) =>
        writeManaged(dropIns, `${String(index).padStart(3, '0')}.json`, {}),
      ),
    );
    expect(await inspectClaudeManagedHooks(managed)).toEqual({ status: 'unknown' });
  });

  it('defers to a present MDM profile instead of reading the files', async () => {
    const managed = await locations();
    await writeManaged(managed.directory, 'managed-settings.json', { disableAllHooks: true });
    const plist = join(managed.root, 'com.anthropic.claudecode.plist');
    const withProfile = {
      ...managed,
      preferencesPaths: [join(managed.root, 'absent.plist'), plist],
    };
    expect(await inspectClaudeManagedHooks(withProfile)).toEqual({
      status: 'restricted',
      setting: 'disableAllHooks',
    });
    await writeFile(plist, 'not parsed');
    expect(await inspectClaudeManagedHooks(withProfile)).toEqual({ status: 'unknown' });

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
      ).toEqual({ status: 'unknown' });
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

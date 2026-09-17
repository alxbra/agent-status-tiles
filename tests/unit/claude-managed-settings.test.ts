import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  await mkdir(join(path, '..'), { recursive: true });
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

    await rm(join(dropIns, '05-lock.json'));
    await writeManaged(dropIns, '.hidden.json', { disableAllHooks: true });
    await writeManaged(dropIns, 'notes.txt', '{ "disableAllHooks": true }');
    await writeManaged(dropIns, 'README.json.bak', { disableAllHooks: true });
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
  });
});

import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadSessionState } from '../../src/main/sessions/persistence';
import { nativeElectronE2eEnabled } from './native-focus';
import { settingsWindow } from './settings-window';

test.beforeEach(() => {
  test.skip(!nativeElectronE2eEnabled(), 'Native Electron tests may take focus; opt in explicitly');
});

const projectRoot = process.cwd();
const mainEntry = resolve(projectRoot, 'out/main/index.js');

test("connecting Claude Code installs owned hooks beside the user's own and disconnecting removes only them", async () => {
  test.skip(process.platform !== 'darwin', 'native overlay targets macOS');
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-connect-e2e-'));
  const userDataDir = join(root, 'user-data');
  const configDirectory = join(root, 'claude-config');
  const helperPath = join(root, 'hook-helper');
  let application: ElectronApplication | undefined;
  try {
    await mkdir(userDataDir);
    await mkdir(configDirectory, { mode: 0o700 });
    await writeFile(helperPath, '#!/bin/sh\nexit 0\n');
    await chmod(helperPath, 0o755);
    const userHook = { type: 'command', command: 'echo user-hook' };
    const original = {
      theme: 'dark',
      hooks: { Stop: [{ matcher: 'Bash', hooks: [userHook] }] },
    };
    const settingsPath = join(configDirectory, 'settings.json');
    await writeFile(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

    application = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, mainEntry],
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AGENT_STATUS_TILES_TEST_HOOK_HELPER: helperPath,
        AGENT_STATUS_TILES_TEST_CLAUDE_CONFIG_DIR: configDirectory,
      },
    });
    const settings = await settingsWindow(application);
    const claude = settings.getByRole('group', { name: 'Claude Code connection' });
    await claude.getByRole('button', { name: 'Connect' }).click();
    await settings.getByRole('alertdialog').getByRole('button', { name: 'Connect' }).click();
    await expect(claude).toContainText('Connected');
    await expect(settings.getByRole('alert')).toHaveCount(0);

    const installed = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      theme: string;
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    expect(installed.theme).toBe('dark');
    expect(installed.hooks.Stop![0]).toEqual({ matcher: 'Bash', hooks: [userHook] });
    expect(Object.keys(installed.hooks)).toHaveLength(12);
    // Electron reports its user-data directory with symlinks resolved.
    const dataDirectory = await realpath(userDataDir);
    for (const groups of Object.values(installed.hooks)) {
      const owned = groups.filter((group) =>
        group.hooks.some((hook) => hook.command.includes(helperPath)),
      );
      expect(owned).toHaveLength(1);
      expect(owned[0]!.hooks[0]!.command).toBe(
        `'${helperPath}' --provider claude --data-dir '${dataDirectory}'`,
      );
    }
    const persisted = await loadSessionState(userDataDir);
    expect(persisted.monitoring.partitions['claude:desktop'].enabled).toBe(true);
    expect(persisted.monitoring.partitions['claude:cli'].enabled).toBe(true);
    // Both surfaces started and verified the hooks; no health sentence appeared.
    await expect(settings.getByRole('alert')).toHaveCount(0);

    // Repair restores a tampered owned entry byte for byte and keeps the row connected.
    const before = await readFile(settingsPath, 'utf8');
    const tampered = JSON.parse(before) as {
      hooks: Record<string, { hooks: { timeout?: number }[] }[]>;
    };
    tampered.hooks.Stop![1]!.hooks[0]!.timeout = 600;
    await writeFile(settingsPath, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(await readFile(settingsPath, 'utf8')).not.toBe(before);
    await claude.getByRole('button', { name: 'Actions for Claude Code' }).click();
    await settings.getByRole('menuitem', { name: 'Repair' }).click();
    await expect.poll(() => readFile(settingsPath, 'utf8')).toBe(before);
    await expect(claude).toContainText('Connected');

    await claude.getByRole('button', { name: 'Actions for Claude Code' }).click();
    await settings.getByRole('menuitem', { name: 'Disconnect' }).click();
    const confirmation = settings.getByRole('alertdialog');
    await expect(confirmation).toContainText("removes this app's hooks from Claude Code settings");
    await confirmation.getByRole('button', { name: 'Disconnect' }).click();
    await expect(claude.getByRole('button', { name: 'Connect' })).toBeEnabled();
    await expect
      .poll(async () => JSON.parse(await readFile(settingsPath, 'utf8')))
      .toEqual(original);
    const after = await loadSessionState(userDataDir);
    expect(after.monitoring.partitions['claude:desktop'].enabled).toBe(false);
    expect(after.monitoring.partitions['claude:cli'].enabled).toBe(false);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a connected Claude row reports missing hooks with one sentence and Repair reinstalls them', async () => {
  test.skip(process.platform !== 'darwin', 'native overlay targets macOS');
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-repair-e2e-'));
  const userDataDir = join(root, 'user-data');
  const configDirectory = join(root, 'claude-config');
  const helperPath = join(root, 'hook-helper');
  let application: ElectronApplication | undefined;
  try {
    await mkdir(userDataDir);
    await mkdir(configDirectory, { mode: 0o700 });
    await writeFile(helperPath, '#!/bin/sh\nexit 0\n');
    await chmod(helperPath, 0o755);
    const settingsPath = join(configDirectory, 'settings.json');
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      AGENT_STATUS_TILES_TEST_HOOK_HELPER: helperPath,
      AGENT_STATUS_TILES_TEST_CLAUDE_CONFIG_DIR: configDirectory,
    };
    application = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, mainEntry],
      cwd: projectRoot,
      env,
    });
    let settings = await settingsWindow(application);
    let claude = settings.getByRole('group', { name: 'Claude Code connection' });
    await claude.getByRole('button', { name: 'Connect' }).click();
    await settings.getByRole('alertdialog').getByRole('button', { name: 'Connect' }).click();
    await expect(claude).toContainText('Connected');
    await application.close();

    // The user wipes the hooks while the app is closed.
    await writeFile(settingsPath, '{}\n');
    application = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, mainEntry],
      cwd: projectRoot,
      env,
    });
    settings = await settingsWindow(application);
    claude = settings.getByRole('group', { name: 'Claude Code connection' });
    await expect(claude).toContainText('Unavailable');
    await expect(settings.getByRole('alert')).toHaveText(
      'Claude Code hooks are not installed. Use Repair to install them.',
    );
    await claude.getByRole('button', { name: 'Actions for Claude Code' }).click();
    await settings.getByRole('menuitem', { name: 'Repair' }).click();
    await expect(claude).toContainText('Connected');
    await expect(settings.getByRole('alert')).toHaveCount(0);
    const repaired = JSON.parse(await readFile(settingsPath, 'utf8')) as { hooks: object };
    expect(Object.keys(repaired.hooks)).toHaveLength(12);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createInitialMonitoringState,
  loadSessionState,
  saveSessionState,
} from '../../src/main/sessions/persistence';
import { nativeElectronE2eEnabled } from './native-focus';

const projectRoot = process.cwd();
const mainEntry = resolve(projectRoot, 'out/main/index.js');
const nativeId = '11111111-1111-7111-8111-111111111111';

test.beforeEach(() => {
  test.skip(!nativeElectronE2eEnabled(), 'Native Electron tests may take focus; opt in explicitly');
});

function line(timestamp: string, type: string, payload: object): string {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}

test('native Desktop and CLI connections baseline independently and reveal surviving owner', async () => {
  test.skip(process.platform !== 'darwin', 'native overlay targets macOS');
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-dual-codex-e2e-'));
  const userDataDir = join(root, 'user-data');
  const sessionsRoot = join(root, 'sessions');
  const desktopPath = join(sessionsRoot, 'desktop.jsonl');
  const cliPath = join(sessionsRoot, 'cli.jsonl');
  const binaryPath = join(root, 'codex');
  const childPidsPath = join(root, 'child-pids');
  let application: ElectronApplication | undefined;
  try {
    await mkdir(userDataDir);
    await mkdir(sessionsRoot);
    await writeFile(
      desktopPath,
      line('2026-09-15T10:00:00.000Z', 'session_meta', {
        id: nativeId,
        source: 'vscode',
        originator: 'Codex Desktop',
      }) +
        line('2026-09-15T10:00:01.000Z', 'event_msg', {
          type: 'task_started',
          turn_id: 'desktop-historical',
        }) +
        line('2026-09-15T10:00:02.000Z', 'event_msg', {
          type: 'task_complete',
          turn_id: 'desktop-historical',
          last_agent_message: 'PRIVATE_DESKTOP',
        }),
    );
    await writeFile(
      cliPath,
      line('2026-09-15T09:00:00.000Z', 'session_meta', {
        id: nativeId,
        source: 'cli',
        originator: 'codex_cli_rs',
      }) +
        line('2026-09-15T09:00:01.000Z', 'event_msg', {
          type: 'task_started',
          turn_id: 'cli-historical',
        }) +
        line('2026-09-15T09:00:02.000Z', 'event_msg', {
          type: 'task_complete',
          turn_id: 'cli-historical',
          last_agent_message: 'PRIVATE_CLI',
        }),
    );
    const initialCliSize = (await readFile(cliPath)).byteLength;
    const records = [
      {
        id: '22222222-2222-7222-8222-222222222222',
        sessionId: nativeId,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_200,
        cwd: '/tmp/desktop-project',
        path: desktopPath,
        cliVersion: 'test',
        source: 'vscode',
        originator: 'Codex Desktop',
        parentThreadId: null,
        forkedFromId: null,
        ephemeral: false,
        preview: 'PRIVATE_PROMPT',
      },
      {
        id: '33333333-3333-7333-8333-333333333333',
        sessionId: nativeId,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_100,
        cwd: '/tmp/cli-project',
        path: cliPath,
        cliVersion: 'test',
        source: 'cli',
        originator: 'codex_cli_rs',
        parentThreadId: null,
        forkedFromId: null,
        ephemeral: false,
        preview: 'PRIVATE_PROMPT',
      },
    ];
    const fakeBinary = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(childPidsPath)}, String(process.pid) + '\\n');
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\\n')) >= 0) {
    const raw = pending.slice(0, end); pending = pending.slice(end + 1);
    let request; try { request = JSON.parse(raw); } catch { continue; }
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({id:request.id,result:{codexHome:'/tmp/test',platformFamily:'unix',platformOs:'macos',userAgent:'test'}})+'\\n');
    } else if (request.method === 'thread/list') {
      const data = request.params.archived ? [] : ${JSON.stringify(records)};
      if (data.length && fs.statSync(${JSON.stringify(cliPath)}).size > ${initialCliSize}) data[1].updatedAt = 1700000300;
      process.stdout.write(JSON.stringify({id:request.id,result:{data,nextCursor:null}})+'\\n');
    }
  }
});
`;
    await writeFile(binaryPath, fakeBinary);
    await chmod(binaryPath, 0o700);
    const monitoring = createInitialMonitoringState();
    monitoring.partitions['codex:desktop'].enabled = true;
    await saveSessionState(userDataDir, monitoring);
    application = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, mainEntry],
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AGENT_STATUS_TILES_TEST_CODEX_BINARY: binaryPath,
        AGENT_STATUS_TILES_TEST_CODEX_CLI_BINARY: binaryPath,
        AGENT_STATUS_TILES_TEST_CODEX_SESSIONS_ROOT: sessionsRoot,
      },
    });
    await expect
      .poll(
        async () =>
          (await loadSessionState(userDataDir)).monitoring.partitions['codex:desktop'].baseline
            .status,
      )
      .toBe('ready');
    const overlay = application
      .windows()
      .find((window) => window.url().includes('/renderer/overlay.html'));
    if (overlay === undefined) throw new Error('Expected native overlay');
    await expect
      .poll(() =>
        overlay.evaluate(async () => (await window.agentStatusTilesOverlay.getState()).sessions),
      )
      .toMatchObject([{ id: 'codex:22222222-2222-7222-8222-222222222222', status: 'idle' }]);
    await appendFile(
      desktopPath,
      line('2026-09-15T10:00:03.000Z', 'event_msg', {
        type: 'task_started',
        turn_id: 'desktop-live',
      }),
    );
    await expect
      .poll(() =>
        overlay.evaluate(async () =>
          (await window.agentStatusTilesOverlay.getState()).sessions.map(
            (session) => session.title,
          ),
        ),
      )
      .toEqual(['desktop-project']);
    // Settings never opens by itself; keep activating until the runtime listens.
    await expect
      .poll(async () => {
        const open = application!
          .windows()
          .some((window) => window.url().includes('/renderer/index.html'));
        if (!open) {
          await application!.evaluate(({ app }) => {
            app.emit('activate');
          });
        }
        return open;
      })
      .toBe(true);
    const settings = application
      .windows()
      .find((window) => window.url().includes('/renderer/index.html'));
    if (settings === undefined) throw new Error('Expected native Settings');
    const cli = settings.getByRole('group', { name: 'Codex CLI connection' });
    await cli.getByRole('button', { name: 'Connect' }).click();
    await expect
      .poll(
        async () =>
          (await loadSessionState(userDataDir)).monitoring.partitions['codex:cli'].baseline.status,
      )
      .toBe('ready');
    await expect
      .poll(() =>
        overlay.evaluate(async () =>
          (await window.agentStatusTilesOverlay.getState()).sessions.map(
            (session) => session.title,
          ),
        ),
      )
      .toEqual(['desktop-project', 'cli-project']);
    const persisted = await loadSessionState(userDataDir);
    expect(persisted.monitoring.partitions['codex:desktop'].enabled).toBe(true);
    expect(persisted.monitoring.partitions['codex:cli'].enabled).toBe(true);
    expect(JSON.stringify(persisted.monitoring)).not.toContain('PRIVATE');
    await appendFile(
      cliPath,
      line('2026-09-15T10:00:04.000Z', 'event_msg', {
        type: 'task_started',
        turn_id: 'cli-live',
      }),
    );
    await expect
      .poll(() =>
        overlay.evaluate(async () =>
          (await window.agentStatusTilesOverlay.getState()).sessions.map(
            (session) => session.title,
          ),
        ),
      )
      .toEqual(['cli-project', 'desktop-project']);
    expect(
      (await loadSessionState(userDataDir)).monitoring.owners[
        'codex:33333333-3333-7333-8333-333333333333'
      ],
    ).toBe('codex:cli');
    const cliFileBefore = await readFile(cliPath, 'utf8');
    await cli.getByRole('button', { name: 'Actions for Codex CLI' }).click();
    await settings.getByRole('menuitem', { name: 'Disconnect' }).click();
    await settings.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
    await expect
      .poll(
        async () =>
          (await loadSessionState(userDataDir)).monitoring.partitions['codex:cli'].enabled,
      )
      .toBe(false);
    const after = await loadSessionState(userDataDir);
    expect(after.monitoring.partitions['codex:cli'].sessions).toEqual({});
    expect(after.monitoring.partitions['codex:desktop'].enabled).toBe(true);
    expect(await readFile(cliPath, 'utf8')).toBe(cliFileBefore);
    await expect
      .poll(() =>
        overlay.evaluate(async () =>
          (await window.agentStatusTilesOverlay.getState()).sessions.map(
            (session) => session.title,
          ),
        ),
      )
      .toEqual(['desktop-project']);
  } finally {
    await application?.close();
    const pids = (await readFile(childPidsPath, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(Number);
    for (const pid of pids) {
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('enabled CLI remains disconnectable after losing its executable', async () => {
  test.skip(process.platform !== 'darwin', 'native overlay targets macOS');
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-cli-lost-reader-e2e-'));
  const userDataDir = join(root, 'user-data');
  const sessionsRoot = join(root, 'sessions');
  let application: ElectronApplication | undefined;
  try {
    await mkdir(userDataDir);
    await mkdir(sessionsRoot);
    const monitoring = createInitialMonitoringState();
    monitoring.partitions['codex:cli'].enabled = true;
    await saveSessionState(userDataDir, monitoring);
    application = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, mainEntry],
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AGENT_STATUS_TILES_TEST_CODEX_CLI_BINARY: join(root, 'missing-codex'),
        AGENT_STATUS_TILES_TEST_CODEX_SESSIONS_ROOT: sessionsRoot,
      },
    });
    // Settings never opens by itself; keep activating until the runtime listens.
    await expect
      .poll(async () => {
        const open = application!
          .windows()
          .some((window) => window.url().includes('/renderer/index.html'));
        if (!open) {
          await application!.evaluate(({ app }) => {
            app.emit('activate');
          });
        }
        return open;
      })
      .toBe(true);
    const settings = application
      .windows()
      .find((window) => window.url().includes('/renderer/index.html'));
    if (settings === undefined) throw new Error('Expected native Settings');
    const cli = settings.getByRole('group', { name: 'Codex CLI connection' });
    await expect(cli).toContainText('Unavailable');
    await expect(settings.getByRole('alert')).toContainText(
      'Codex CLI connection or coverage is incomplete',
    );
    await cli.getByRole('button', { name: 'Actions for Codex CLI' }).click();
    await settings.getByRole('menuitem', { name: 'Disconnect' }).click();
    await settings.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
    await expect
      .poll(
        async () =>
          (await loadSessionState(userDataDir)).monitoring.partitions['codex:cli'].enabled,
      )
      .toBe(false);
    await expect(cli.getByRole('button', { name: 'Connect' })).toBeEnabled();
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

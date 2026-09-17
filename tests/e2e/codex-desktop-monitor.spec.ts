import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createInitialMonitoringState,
  loadSessionState,
  saveSessionState,
} from '../../src/main/sessions/persistence';
import { nativeElectronE2eEnabled } from './native-focus';

test.beforeEach(() => {
  test.skip(!nativeElectronE2eEnabled(), 'Native Electron tests may take focus; opt in explicitly');
});

const projectRoot = process.cwd();
const mainEntry = resolve(projectRoot, 'out/main/index.js');
const nativeId = '11111111-1111-7111-8111-111111111111';

function line(timestamp: string, type: string, payload: object): string {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}

async function overlayWindow(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(() =>
      application.windows().some((window) => window.url().includes('/renderer/overlay.html')),
    )
    .toBe(true);
  const overlay = application
    .windows()
    .find((window) => window.url().includes('/renderer/overlay.html'));
  if (overlay === undefined) throw new Error('Expected native overlay');
  return overlay;
}

test('native Desktop baseline shows historical completion as idle then publishes new work', async () => {
  test.skip(process.platform !== 'darwin', 'native overlay targets macOS');
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-desktop-e2e-'));
  const userDataDir = join(root, 'user-data');
  const sessionsRoot = join(root, 'sessions');
  const rolloutPath = join(sessionsRoot, 'rollout.jsonl');
  const binaryPath = join(root, 'codex');
  const childPidPath = join(root, 'child.pid');
  let application: ElectronApplication | undefined;
  try {
    await mkdir(userDataDir);
    await mkdir(sessionsRoot);
    await writeFile(
      rolloutPath,
      line('2026-09-15T10:00:00.000Z', 'session_meta', {
        id: nativeId,
        source: 'vscode',
        originator: 'Codex Desktop',
      }) +
        line('2026-09-15T10:00:01.000Z', 'event_msg', {
          type: 'task_started',
          turn_id: 'historical',
        }) +
        line('2026-09-15T10:00:02.000Z', 'event_msg', {
          type: 'task_complete',
          turn_id: 'historical',
          last_agent_message: 'PRIVATE',
        }),
    );
    const catalogRecord = {
      id: '22222222-2222-7222-8222-222222222222',
      name: 'Codex task title',
      sessionId: nativeId,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      cwd: '/tmp/example-project',
      path: rolloutPath,
      cliVersion: 'test',
      source: 'vscode',
      originator: 'Codex Desktop',
      parentThreadId: null,
      forkedFromId: null,
      ephemeral: false,
      preview: 'PRIVATE_PROMPT',
    };
    const ambiguousLegacyRecord = {
      ...catalogRecord,
      id: '33333333-3333-7333-8333-333333333333',
      sessionId: '33333333-3333-7333-8333-333333333333',
      path: join(sessionsRoot, 'legacy.jsonl'),
      originator: null,
    };
    const fakeBinary = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
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
      const data = request.params.archived ? [] : ${JSON.stringify([catalogRecord, ambiguousLegacyRecord])};
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
    const launchOptions = {
      args: [`--user-data-dir=${userDataDir}`, mainEntry],
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AGENT_STATUS_TILES_TEST_CODEX_BINARY: binaryPath,
        AGENT_STATUS_TILES_TEST_CODEX_SESSIONS_ROOT: sessionsRoot,
      },
    };
    application = await electron.launch(launchOptions);
    const overlay = await overlayWindow(application);
    await expect
      .poll(
        async () =>
          (await loadSessionState(userDataDir)).monitoring.partitions['codex:desktop'].baseline
            .status,
      )
      .toBe('ready');
    await expect
      .poll(() =>
        overlay.evaluate(async () => (await window.agentStatusTilesOverlay.getState()).sessions),
      )
      .toMatchObject([{ id: 'codex:22222222-2222-7222-8222-222222222222', status: 'idle' }]);
    const stateText = await readFile(join(userDataDir, 'session-state.json'), 'utf8');
    expect(stateText).toContain('Codex task title');
    expect(stateText).not.toContain('PRIVATE');
    expect(
      (
        await overlay.evaluate(
          async () => (await window.agentStatusTilesOverlay.getState()).sessions,
        )
      )[0]?.title,
    ).toBe('Codex task title');
    await appendFile(
      rolloutPath,
      line('2026-09-15T10:00:03.000Z', 'event_msg', { type: 'task_started', turn_id: 'live' }),
    );
    await expect
      .poll(() =>
        overlay.evaluate(async () =>
          (await window.agentStatusTilesOverlay.getState()).sessions.map(
            (session) => session.status,
          ),
        ),
      )
      .toContain('working');
    await appendFile(
      rolloutPath,
      line('2026-09-15T10:00:04.000Z', 'response_item', {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'call-live',
        turn_id: 'live',
        arguments: 'PRIVATE_INPUT_REQUEST',
      }),
    );
    await expect
      .poll(() =>
        overlay.evaluate(async () =>
          (await window.agentStatusTilesOverlay.getState()).sessions.map(
            (session) => session.status,
          ),
        ),
      )
      .toContain('needs-input');
    await appendFile(
      rolloutPath,
      line('2026-09-15T10:00:05.000Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'call-live',
        turn_id: 'live',
        output: 'PRIVATE_INPUT_RESPONSE',
      }),
    );
    await expect
      .poll(() =>
        overlay.evaluate(async () =>
          (await window.agentStatusTilesOverlay.getState()).sessions.map(
            (session) => session.status,
          ),
        ),
      )
      .toContain('working');
    await appendFile(
      rolloutPath,
      line('2026-09-15T10:00:06.000Z', 'event_msg', {
        type: 'task_complete',
        turn_id: 'live',
        last_agent_message: 'PRIVATE_COMPLETION',
      }),
    );
    await expect
      .poll(() =>
        overlay.evaluate(async () =>
          (await window.agentStatusTilesOverlay.getState()).sessions.map(
            (session) => session.status,
          ),
        ),
      )
      .toContain('unread');
    expect(await readFile(join(userDataDir, 'session-state.json'), 'utf8')).not.toContain(
      'PRIVATE',
    );
    await application.close();
    application = undefined;
    const pid = Number(await readFile(childPidPath, 'utf8'));
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
    application = await electron.launch(launchOptions);
    const restartedOverlay = await overlayWindow(application);
    await expect
      .poll(() =>
        restartedOverlay.evaluate(async () =>
          (await window.agentStatusTilesOverlay.getState()).sessions.map(
            (session) => session.status,
          ),
        ),
      )
      .toContain('unread');
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
    if (settings === undefined) throw new Error('Expected native Settings window');
    const desktop = settings.getByRole('group', { name: 'Codex Desktop connection' });
    const cli = settings.getByRole('group', { name: 'Codex CLI connection' });
    await expect(desktop).toContainText('Connected');
    await expect(settings.getByRole('alert')).toHaveCount(0);
    await expect(desktop.getByRole('button', { name: 'Actions for Codex Desktop' })).toBeVisible();
    await expect(cli.getByRole('button', { name: 'Connect' })).toBeEnabled();
    await desktop.getByRole('button', { name: 'Actions for Codex Desktop' }).click();
    await settings.getByRole('menuitem', { name: 'Disconnect' }).click();
    const confirmation = settings.getByRole('alertdialog');
    await expect(confirmation).toContainText(
      "Disconnect removes this app's local status history but does not change Codex data.",
    );
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    expect(
      (await loadSessionState(userDataDir)).monitoring.partitions['codex:desktop'].enabled,
    ).toBe(true);
    const codexFileBefore = await readFile(rolloutPath, 'utf8');
    await desktop.getByRole('button', { name: 'Actions for Codex Desktop' }).click();
    await settings.getByRole('menuitem', { name: 'Disconnect' }).click();
    await settings.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
    await expect
      .poll(
        async () =>
          (await loadSessionState(userDataDir)).monitoring.partitions['codex:desktop'].enabled,
      )
      .toBe(false);
    const disconnected = (await loadSessionState(userDataDir)).monitoring.partitions[
      'codex:desktop'
    ];
    expect(disconnected.sessions).toEqual({});
    expect(disconnected.cursors).toEqual({});
    expect(await readFile(rolloutPath, 'utf8')).toBe(codexFileBefore);
    await expect
      .poll(() =>
        restartedOverlay.evaluate(
          async () => (await window.agentStatusTilesOverlay.getState()).sessions,
        ),
      )
      .toEqual([]);
    await desktop.getByRole('button', { name: 'Connect' }).click();
    await expect
      .poll(
        async () =>
          (await loadSessionState(userDataDir)).monitoring.partitions['codex:desktop'].baseline
            .status,
      )
      .toBe('ready');
    await expect
      .poll(() =>
        restartedOverlay.evaluate(
          async () => (await window.agentStatusTilesOverlay.getState()).sessions,
        ),
      )
      .toMatchObject([{ id: 'codex:22222222-2222-7222-8222-222222222222', status: 'idle' }]);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native overlay fills five recent slots when catalog originator needs rollout proof', async () => {
  test.skip(process.platform !== 'darwin', 'native overlay targets macOS');
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-five-threads-e2e-'));
  const userDataDir = join(root, 'user-data');
  const sessionsRoot = join(root, 'sessions');
  const binaryPath = join(root, 'codex');
  let application: ElectronApplication | undefined;
  try {
    await mkdir(userDataDir);
    await mkdir(sessionsRoot);
    const records = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const id = `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
        const path = join(sessionsRoot, `rollout-${index + 1}.jsonl`);
        await writeFile(
          path,
          line('2026-09-15T10:00:00.000Z', 'session_meta', {
            id,
            source: 'vscode',
            originator: index === 5 ? 'Other Editor' : 'Codex Desktop',
          }),
        );
        return {
          id,
          sessionId: id,
          createdAt: 1_700_000_000,
          updatedAt: 1_700_000_100 + index,
          cwd: '/tmp/example-project',
          path,
          cliVersion: 'test',
          source: 'vscode',
          originator: index >= 4 ? null : 'Codex Desktop',
          parentThreadId: null,
          ephemeral: false,
        };
      }),
    );
    await writeFile(
      binaryPath,
      `#!/usr/bin/env node
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
      process.stdout.write(JSON.stringify({id:request.id,result:{data,nextCursor:null}})+'\\n');
    }
  }
});
`,
    );
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
        AGENT_STATUS_TILES_TEST_CODEX_SESSIONS_ROOT: sessionsRoot,
      },
    });
    const overlay = await overlayWindow(application);
    await expect
      .poll(() =>
        overlay.evaluate(async () => (await window.agentStatusTilesOverlay.getState()).sessions),
      )
      .toHaveLength(5);
    await expect(overlay.locator('.status-tiles__tile')).toHaveCount(5);
    const visibleIds = await overlay.evaluate(async () =>
      (await window.agentStatusTilesOverlay.getState()).sessions.map((session) => session.id),
    );
    expect(visibleIds).toContain(`codex:${records[4].id}`);
    expect(visibleIds).not.toContain(`codex:${records[5].id}`);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('enabled Desktop connection remains disconnectable when its reader is lost', async () => {
  test.skip(process.platform !== 'darwin', 'native overlay targets macOS');
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-lost-reader-e2e-'));
  const userDataDir = join(root, 'user-data');
  const sessionsRoot = join(root, 'sessions');
  let application: ElectronApplication | undefined;
  try {
    await mkdir(userDataDir);
    await mkdir(sessionsRoot);
    const monitoring = createInitialMonitoringState();
    monitoring.partitions['codex:desktop'].enabled = true;
    await saveSessionState(userDataDir, monitoring);
    application = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, mainEntry],
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AGENT_STATUS_TILES_TEST_CODEX_BINARY: join(root, 'missing-codex'),
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
    if (settings === undefined) throw new Error('Expected native Settings window');
    const desktop = settings.getByRole('group', { name: 'Codex Desktop connection' });
    await expect(desktop).toContainText('Unavailable');
    await expect(settings.getByRole('alert')).toContainText('coverage is incomplete');
    await desktop.getByRole('button', { name: 'Actions for Codex Desktop' }).click();
    await settings.getByRole('menuitem', { name: 'Disconnect' }).click();
    await settings.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
    await expect
      .poll(
        async () =>
          (await loadSessionState(userDataDir)).monitoring.partitions['codex:desktop'].enabled,
      )
      .toBe(false);
    await expect(desktop.getByRole('button', { name: 'Connect' })).toBeEnabled();
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

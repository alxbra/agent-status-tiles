import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createInitialMonitoringState,
  saveSessionState,
} from '../../src/main/sessions/persistence';
import { reduceSessionState } from '../../src/main/sessions/reducer';
import { createInitialSessionState, makeSessionId } from '../../src/shared/session';
import { nativeElectronE2eEnabled } from './native-focus';

test.beforeEach(() => {
  test.skip(!nativeElectronE2eEnabled(), 'Native Electron tests may take focus; opt in explicitly');
});

const projectRoot = process.cwd();
const mainEntry = resolve(projectRoot, 'out/main/index.js');
const sessionId = makeSessionId('codex', 'native-runtime-fixture');

function checkpoint(baseline: 'pending' | 'ready') {
  const state = reduceSessionState(
    reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'codex',
      surface: 'desktop',
      nativeSessionId: 'native-runtime-fixture',
      title: 'Fixture project',
      isTopLevel: true,
      isArchived: false,
      canOpen: false,
      updatedAt: 1,
    }),
    { type: 'turn-started', sessionId, turnId: 'fixture-turn', timestamp: 2 },
  );
  const monitoring = createInitialMonitoringState();
  const partition = monitoring.partitions['codex:desktop'];
  partition.enabled = true;
  partition.baseline =
    baseline === 'ready' ? { status: 'ready', cutoff: 3 } : { status: 'pending' };
  partition.sessions = state.sessions;
  partition.order = state.order;
  monitoring.globalOrder = state.order;
  monitoring.owners = { [sessionId]: 'codex:desktop' };
  return monitoring;
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [`--user-data-dir=${userDataDir}`, mainEntry],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test' },
  });
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
  if (overlay === undefined) throw new Error('Expected the native overlay');
  return overlay;
}

test('native restart publishes only ready surface observations', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-runtime-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    await saveSessionState(userDataDir, checkpoint('ready'));
    application = await launch(userDataDir);
    const readyOverlay = await overlayWindow(application);
    await expect
      .poll(() => readyOverlay.evaluate(() => window.agentStatusTilesOverlay.getState()))
      .toMatchObject({
        sessions: [{ id: sessionId, title: 'Fixture project', canOpen: true }],
      });

    await application.close();
    application = undefined;
    await saveSessionState(userDataDir, checkpoint('pending'));
    application = await launch(userDataDir);
    const pendingOverlay = await overlayWindow(application);
    // Let the asynchronous persisted-state restore settle before asserting
    // that a pending baseline did not publish its retained working record.
    await pendingOverlay.waitForTimeout(250);
    await expect
      .poll(() => pendingOverlay.evaluate(() => window.agentStatusTilesOverlay.getState()))
      .toMatchObject({ sessions: [] });
  } finally {
    await application?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

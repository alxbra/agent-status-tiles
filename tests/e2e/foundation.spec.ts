import { expect, test, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = process.cwd();
const mainEntry = resolve(projectRoot, 'out/main/index.js');
const electronExecutable = resolve(
  projectRoot,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [`--user-data-dir=${userDataDir}`, mainEntry],
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });
}

async function closeApplication(application: ElectronApplication | undefined): Promise<void> {
  if (application) {
    await application.close();
  }
}

async function closePage(page: Page): Promise<void> {
  const closePromise = page.waitForEvent('close');
  const closeInvocation = page
    .evaluate(() => window.agentStatusTiles.closeSettings())
    .catch(() => undefined);
  await Promise.all([closePromise, closeInvocation]);
}

test('launches the built Settings window with the typed bridge', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir);
    const page = await application.firstWindow();

    await expect(page).toHaveTitle('Settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('body')).toContainText('Settings');
    expect(await page.evaluate(() => window.agentStatusTiles.getVersion())).toBe('0.1.0');
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');

    const rendererUrl = page.url();
    await page.evaluate(() => {
      window.location.href = 'https://example.com/should-not-load';
    });
    await page.waitForTimeout(100);
    expect(page.url()).toBe(rendererUrl);

    await closePage(page);
    expect(application.windows()).toHaveLength(0);
  } finally {
    await closeApplication(application);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('keeps a single application instance for one user-data directory', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-e2e-'));
  let firstApplication: ElectronApplication | undefined;

  try {
    firstApplication = await launch(userDataDir);
    const firstWindow = await firstApplication.firstWindow();
    await expect(firstWindow).toHaveTitle('Settings');

    const secondProcess = spawn(electronExecutable, [`--user-data-dir=${userDataDir}`, mainEntry], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'ignore',
    });
    const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolveExit, rejectExit) => {
        secondProcess.once('error', rejectExit);
        secondProcess.once('exit', (code, exitSignal) => resolveExit([code, exitSignal]));
      },
    );

    expect(exitCode).toBe(0);
    expect(signal).toBeNull();
    expect(firstApplication.windows()).toHaveLength(1);
    const firstWindowAgain = await firstApplication.firstWindow();
    await expect(firstWindowAgain).toHaveTitle('Settings');
  } finally {
    await closeApplication(firstApplication);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

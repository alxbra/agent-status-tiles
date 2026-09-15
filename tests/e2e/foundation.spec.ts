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

async function launch(
  userDataDir: string,
  testSessionCount?: number,
): Promise<ElectronApplication> {
  const args = [`--user-data-dir=${userDataDir}`, mainEntry];
  if (testSessionCount !== undefined) {
    args.push(`--agent-status-tiles-test-session-count=${String(testSessionCount)}`);
  }
  return electron.launch({
    args,
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });
}

async function overlayWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const existingOverlayWindow = application
      .windows()
      .find((window) => window.url().includes('/renderer/overlay.html'));
    if (existingOverlayWindow) return existingOverlayWindow;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the overlay window to load');
}

async function settingsWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const existingSettingsWindow = application
      .windows()
      .find((window) => window.url().includes('/renderer/index.html'));
    if (existingSettingsWindow) {
      return existingSettingsWindow;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for the Settings window to load');
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
    const page = await settingsWindow(application);

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
    expect(
      application.windows().filter((window) => window.url().includes('/renderer/index.html')),
    ).toHaveLength(0);
  } finally {
    await closeApplication(application);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('creates a hidden nonactivating overlay in the primary work area', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir);
    await settingsWindow(application);

    const shell = await application.evaluate(({ BrowserWindow, app, screen }) => {
      const workArea = screen.getPrimaryDisplay().workArea;
      const width = Math.max(1, Math.min(360, workArea.width));
      const height = Math.max(1, Math.min(480, workArea.height));
      return {
        dockVisible: app.dock?.isVisible() ?? false,
        workArea,
        expectedOverlayBounds: {
          x: workArea.x + workArea.width - width,
          y: workArea.y + Math.round((workArea.height - height) / 2),
          width,
          height,
        },
        windows: BrowserWindow.getAllWindows().map((window) => ({
          title: window.getTitle(),
          visible: window.isVisible(),
          focusable: window.isFocusable(),
          alwaysOnTop: window.isAlwaysOnTop(),
          allWorkspaces: window.isVisibleOnAllWorkspaces(),
          bounds: window.getBounds(),
          url: window.webContents.getURL(),
        })),
      };
    });

    expect(shell.dockVisible).toBe(false);
    expect(shell.windows).toHaveLength(2);
    const overlay = shell.windows.find((window) => window.url.includes('/renderer/overlay.html'));
    expect(overlay).toBeDefined();
    expect(overlay).toMatchObject({
      visible: false,
      focusable: false,
      alwaysOnTop: true,
      allWorkspaces: true,
      bounds: shell.expectedOverlayBounds,
    });
    expect(overlay?.url).toContain('/out/renderer/overlay.html');
    const overlayPage = application
      .windows()
      .find((window) => window.url().includes('/renderer/overlay.html'));
    expect(await overlayPage?.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );
  } finally {
    await closeApplication(application);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

for (const testSessionCount of [0, 1, 12, 30]) {
  test(`projects ${String(testSessionCount)} bounded test sessions through the native overlay`, async () => {
    test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
    const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-overlay-e2e-'));
    let application: ElectronApplication | undefined;

    try {
      application = await launch(userDataDir, testSessionCount);
      await settingsWindow(application);
      const page = await overlayWindow(application);
      const state = await page.evaluate(() => window.agentStatusTilesOverlay.getState());
      expect(state.sessions).toHaveLength(testSessionCount);
      expect(Object.keys(state)).toEqual(['sessions', 'reducedMotion']);
      expect(JSON.stringify(state)).not.toMatch(/prompt|transcript|credential|filesystem/u);
      expect(await page.evaluate(() => typeof window.agentStatusTiles)).toBe('undefined');
      expect(await page.evaluate(() => typeof window.require)).toBe('undefined');

      await expect
        .poll(() =>
          application!.evaluate(({ BrowserWindow }) => {
            const overlay = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().includes('/renderer/overlay.html'),
            );
            return {
              isLoadingMainFrame: overlay?.webContents.isLoadingMainFrame() ?? true,
              isVisible: overlay?.isVisible() ?? false,
            };
          }),
        )
        .toEqual({
          isLoadingMainFrame: false,
          isVisible: testSessionCount > 0,
        });

      const tiles = page.locator('.status-tiles__tile');
      await expect(tiles).toHaveCount(Math.min(testSessionCount, 12));
      if (testSessionCount === 0) {
        await expect(page.locator('.status-tiles')).toHaveCount(0);
      } else {
        await expect(page.getByRole('listbox', { name: 'Agent status sessions' })).toBeVisible();
        await expect(page.getByRole('option').first()).toHaveAttribute(
          'aria-label',
          /Test session 1/u,
        );
        if (testSessionCount > 12) {
          await expect(page.locator('.status-tiles__indicator--next')).toBeVisible();
        } else {
          await expect(page.locator('.status-tiles__indicator')).toHaveCount(0);
        }
      }
    } finally {
      await closeApplication(application);
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
}

for (const testSessionCount of [1, 12]) {
  test(`keeps portal hit regions bounded for ${String(testSessionCount)} synthetic sessions`, async () => {
    test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
    const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-portal-e2e-'));
    let application: ElectronApplication | undefined;

    try {
      application = await launch(userDataDir, testSessionCount);
      await settingsWindow(application);
      const page = await overlayWindow(application);
      await expect(page.locator('.status-tiles__tile')).toHaveCount(testSessionCount);

      const firstTile = page.locator('.status-tiles__tile').first();
      await firstTile.hover();
      const tooltip = page.locator('[data-slot="tooltip-content"]');
      await expect(tooltip).toBeVisible();
      const tooltipBounds = await tooltip.boundingBox();
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      if (tooltipBounds === null) throw new Error('Tooltip has no bounds');
      expect(tooltipBounds.x).toBeGreaterThanOrEqual(0);
      expect(tooltipBounds.y).toBeGreaterThanOrEqual(0);
      expect(tooltipBounds.x + tooltipBounds.width).toBeLessThanOrEqual(viewport.width);
      expect(tooltipBounds.y + tooltipBounds.height).toBeLessThanOrEqual(viewport.height);

      await firstTile.click({ button: 'right' });
      const contextMenu = page.locator('[data-slot="context-menu-content"]');
      await expect(contextMenu).toBeVisible();
      const contextMenuBounds = await contextMenu.boundingBox();
      if (contextMenuBounds === null) throw new Error('Context menu has no bounds');
      expect(contextMenuBounds.x).toBeGreaterThanOrEqual(0);
      expect(contextMenuBounds.y).toBeGreaterThanOrEqual(0);
      expect(contextMenuBounds.x + contextMenuBounds.width).toBeLessThanOrEqual(viewport.width);
      expect(contextMenuBounds.y + contextMenuBounds.height).toBeLessThanOrEqual(viewport.height);

      await page.mouse.move(1, 1);
      await expect(contextMenu).toBeHidden();

      const rejected = await page.evaluate(() => {
        const invalidNegative = window.agentStatusTilesOverlay.publishHitRegions([
          { x: -1, y: 0, width: 1, height: 1 },
        ]);
        const tooMany = window.agentStatusTilesOverlay.publishHitRegions(
          Array.from({ length: 15 }, () => ({ x: 0, y: 0, width: 1, height: 1 })),
        );
        const outOfBounds = window.agentStatusTilesOverlay.publishHitRegions([
          { x: window.innerWidth - 1, y: 0, width: 2, height: 1 },
        ]);
        return Promise.all([invalidNegative, tooMany, outOfBounds]);
      });
      expect(rejected).toEqual([false, false, false]);
    } finally {
      await closeApplication(application);
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
}

test('keeps a single application instance for one user-data directory', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-e2e-'));
  let firstApplication: ElectronApplication | undefined;

  try {
    firstApplication = await launch(userDataDir);
    const firstWindow = await settingsWindow(firstApplication);
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
    expect(
      firstApplication.windows().filter((window) => window.url().includes('/renderer/index.html')),
    ).toHaveLength(1);
    const firstWindowAgain = await settingsWindow(firstApplication);
    await expect(firstWindowAgain).toHaveTitle('Settings');
  } finally {
    await closeApplication(firstApplication);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

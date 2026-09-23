import { expect, test, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeElectronE2eEnabled } from './native-focus';
import { findSettingsWindow, settingsWindow } from './settings-window';

test.beforeEach(() => {
  test.skip(!nativeElectronE2eEnabled(), 'Native Electron tests may take focus; opt in explicitly');
});

const projectRoot = process.cwd();
const mainEntry = resolve(projectRoot, 'out/main/index.js');
const electronExecutable = resolve(
  projectRoot,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);

async function launch(
  userDataDir: string,
  testSessionCount?: number,
  enterKeyboardMode = false,
): Promise<ElectronApplication> {
  const args = [`--user-data-dir=${userDataDir}`, mainEntry];
  if (testSessionCount !== undefined) {
    args.push(`--agent-status-tiles-test-session-count=${String(testSessionCount)}`);
  }
  if (enterKeyboardMode) {
    args.push('--agent-status-tiles-test-keyboard-entry');
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

test('enters and exits native keyboard mode without hiding the overlay', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-keyboard-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir, 1, true);
    await expect
      .poll(() =>
        application!.evaluate(
          () =>
            typeof Reflect.get(globalThis, Symbol.for('agent-status-tiles.test.keyboard-entry')),
        ),
      )
      .toBe('function');
    await application.evaluate(() => {
      const entry = Reflect.get(
        globalThis,
        Symbol.for('agent-status-tiles.test.keyboard-entry'),
      ) as unknown;
      if (typeof entry !== 'function') throw new Error('Keyboard-entry test hook is unavailable');
      entry();
    });
    const settings = await settingsWindow(application);
    const overlay = await overlayWindow(application);
    await closePage(settings);

    await expect(overlay.locator('.dynamic-island__pill')).toBeFocused();
    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().includes('/renderer/overlay.html'),
          );
          return {
            focusable: window?.isFocusable() ?? false,
            visible: window?.isVisible() ?? false,
          };
        }),
      )
      .toEqual({
        focusable: true,
        visible: true,
      });

    await overlay.keyboard.press('Escape');
    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().includes('/renderer/overlay.html'),
          );
          return {
            focusable: window?.isFocusable() ?? true,
            focused: window?.isFocused() ?? true,
            visible: window?.isVisible() ?? false,
          };
        }),
      )
      .toEqual({ focusable: false, focused: false, visible: true });
    expect(
      application.windows().filter((window) => window.url().includes('/renderer/index.html')),
    ).toHaveLength(0);
    await application.evaluate(({ app }) => {
      app.emit('activate');
    });
    await settingsWindow(application);
    expect(
      application.windows().filter((window) => window.url().includes('/renderer/index.html')),
    ).toHaveLength(1);
  } finally {
    await closeApplication(application);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

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

test('wires production settings through preload, overlay state, and restart persistence', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-settings-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir, 1);
    const page = await settingsWindow(application);
    const overlay = await overlayWindow(application);

    await expect(page.getByRole('combobox', { name: 'Display' })).toContainText('Primary');
    // One row per provider, both connectable.
    await expect(page.getByRole('button', { name: 'Connect' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Connect' }).first()).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Connect' }).nth(1)).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Open Advanced settings' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Reduce motion' })).not.toBeChecked();
    const settings = await page.evaluate(() => window.agentStatusTiles.getSettings());
    expect(Object.keys(settings).sort()).toEqual([
      'displays',
      'launchAtLogin',
      'providers',
      'recentThreadLimit',
      'reduceMotion',
      'selectedDisplayId',
    ]);
    expect(settings.selectedDisplayId).toBe('primary');
    expect(settings.recentThreadLimit).toBe(5);
    expect(JSON.stringify(settings)).not.toMatch(/prompt|transcript|credential|filesystem|path/u);

    const physicalDisplay = settings.displays.find((display) => display.id !== 'primary');
    if (physicalDisplay === undefined) throw new Error('Expected one physical display option');
    await page.getByRole('combobox', { name: 'Display' }).click();
    await page.getByRole('option', { name: physicalDisplay.label }).click();
    await expect(page.getByRole('combobox', { name: 'Display' })).toContainText(
      physicalDisplay.label,
    );

    await page.getByRole('switch', { name: 'Reduce motion' }).click();
    await expect(page.getByRole('switch', { name: 'Reduce motion' })).toBeChecked();
    await expect
      .poll(() => overlay.evaluate(() => window.agentStatusTilesOverlay.getState()))
      .toMatchObject({
        reducedMotion: true,
      });
    await page.getByRole('combobox', { name: 'Recent threads' }).click();
    await page.getByRole('option', { name: '3', exact: true }).click();
    expect(
      (await page.evaluate(() => window.agentStatusTiles.getSettings())).recentThreadLimit,
    ).toBe(3);

    await closeApplication(application);
    application = await launch(userDataDir, 1);
    const restartedSettings = await settingsWindow(application);
    await expect(restartedSettings.getByRole('switch', { name: 'Reduce motion' })).toBeChecked();
    const restartedState = await restartedSettings.evaluate(() =>
      window.agentStatusTiles.getSettings(),
    );
    expect(restartedState.reduceMotion).toBe(true);
    expect(restartedState.recentThreadLimit).toBe(3);
    expect(restartedState.selectedDisplayId).toBe(physicalDisplay.id);
    await expect(restartedSettings.getByRole('combobox', { name: 'Display' })).toContainText(
      physicalDisplay.label,
    );
  } finally {
    await closeApplication(application);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('creates a hidden nonactivating overlay at the top center of the primary display', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir);
    await settingsWindow(application);

    const shell = await application.evaluate(({ BrowserWindow, app, screen }) => {
      const bounds = screen.getPrimaryDisplay().bounds;
      const width = Math.max(1, Math.min(360, bounds.width));
      const height = Math.max(1, Math.min(56, bounds.height));
      return {
        dockVisible: app.dock?.isVisible() ?? false,
        expectedOverlayBounds: {
          x: Math.round(bounds.x + (bounds.width - width) / 2),
          y: bounds.y,
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

test('recreates one native overlay after an unexpected close', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-recovery-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir, 1);
    await settingsWindow(application);
    const initialOverlayPage = await overlayWindow(application);
    const initialOverlayState = await initialOverlayPage.evaluate(() =>
      window.agentStatusTilesOverlay.getState(),
    );
    const initialBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Overlay window is unavailable');
      return window.getBounds();
    });
    const initialOverlayId = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Overlay window is unavailable');
      return window.webContents.id;
    });

    const overlayClosed = initialOverlayPage.waitForEvent('close').catch(() => undefined);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Overlay window is unavailable');
      window.destroy();
    });
    await overlayClosed;

    await expect
      .poll(() =>
        application!.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((window) =>
              window.webContents.getURL().includes('/renderer/overlay.html'),
            ).length,
        ),
      )
      .toBe(1);
    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().includes('/renderer/overlay.html'),
          );
          return window === undefined
            ? null
            : {
                id: window.webContents.id,
                visible: window.isVisible(),
                focusable: window.isFocusable(),
                destroyed: window.isDestroyed(),
              };
        }),
      )
      .toMatchObject({ visible: true, focusable: false, destroyed: false });
    const replacementOverlayId = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Replacement overlay window is unavailable');
      return window.webContents.id;
    });
    expect(replacementOverlayId).not.toBe(initialOverlayId);

    const replacement = await overlayWindow(application);
    await expect(replacement.locator('.dynamic-island__pill')).toHaveCount(1);
    expect(await replacement.evaluate(() => window.agentStatusTilesOverlay.getState())).toEqual(
      initialOverlayState,
    );
    await application.evaluate(({ BrowserWindow, powerMonitor }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Replacement overlay window is unavailable');
      window.setBounds({ x: 0, y: 0, width: 100, height: 100 });
      powerMonitor.emit('resume');
    });
    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().includes('/renderer/overlay.html'),
          );
          return window?.getBounds() ?? null;
        }),
      )
      .toEqual(initialBounds);
  } finally {
    await closeApplication(application);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('recreates the native overlay after a renderer crash', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-crash-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir, 1);
    await settingsWindow(application);
    const initialOverlay = await overlayWindow(application);
    const initialState = await initialOverlay.evaluate(() =>
      window.agentStatusTilesOverlay.getState(),
    );
    const initialId = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Overlay window is unavailable');
      return window.webContents.id;
    });
    const crashed = initialOverlay.waitForEvent('crash').catch(() => undefined);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Overlay window is unavailable');
      window.webContents.forcefullyCrashRenderer();
    });
    await crashed;

    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().includes('/renderer/overlay.html'),
          );
          return window === undefined
            ? null
            : {
                id: window.webContents.id,
                crashed: window.webContents.isCrashed(),
                visible: window.isVisible(),
                focusable: window.isFocusable(),
              };
        }),
      )
      .toMatchObject({ crashed: false, visible: true, focusable: false });
    const replacement = await overlayWindow(application);
    const replacementId = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Replacement overlay window is unavailable');
      return window.webContents.id;
    });
    expect(replacementId).not.toBe(initialId);
    expect(await replacement.evaluate(() => window.agentStatusTilesOverlay.getState())).toEqual(
      initialState,
    );
    await expect(replacement.locator('.dynamic-island__pill')).toHaveCount(1);
  } finally {
    await closeApplication(application);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('recreates the native overlay after a main-frame load failure', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-reload-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir, 1);
    await settingsWindow(application);
    const initialOverlay = await overlayWindow(application);
    const initialState = await initialOverlay.evaluate(() =>
      window.agentStatusTilesOverlay.getState(),
    );
    const initialId = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Overlay window is unavailable');
      return window.webContents.id;
    });

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Overlay window is unavailable');
      window.webContents.emit(
        'did-fail-provisional-load',
        {} as never,
        -3,
        'ERR_ABORTED',
        window.webContents.getURL(),
        true,
        window.webContents.getProcessId(),
        window.webContents.mainFrame.routingId,
      );
    });

    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().includes('/renderer/overlay.html'),
          );
          return window?.webContents.id ?? null;
        }),
      )
      .not.toBe(initialId);
    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().includes('/renderer/overlay.html'),
          );
          return window === undefined
            ? null
            : { visible: window.isVisible(), focusable: window.isFocusable() };
        }),
      )
      .toEqual({ visible: true, focusable: false });
    const replacementId = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/renderer/overlay.html'),
      );
      if (window === undefined) throw new Error('Replacement overlay window is unavailable');
      return window.webContents.id;
    });
    expect(replacementId).not.toBe(initialId);
    const replacement = await overlayWindow(application);
    expect(await replacement.evaluate(() => window.agentStatusTilesOverlay.getState())).toEqual(
      initialState,
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

      const pill = page.locator('.dynamic-island__pill');
      if (testSessionCount === 0) {
        await expect(page.locator('.dynamic-island')).toHaveCount(0);
      } else {
        // Test sessions alternate Codex and Claude while cycling working,
        // needs input, done, and error: Codex keeps a working thread, and
        // Claude's needs input outranks its failed one once it has two.
        const expectedLabel =
          testSessionCount === 1
            ? 'Codex working, Claude idle'
            : 'Codex working, Claude needs input';
        await expect(pill).toHaveAttribute('aria-label', expectedLabel);
        await expect(page.locator('.dynamic-island__name')).toHaveText(['Codex', 'Claude']);
        await expect
          .poll(() =>
            page
              .locator('.dynamic-island__harness')
              .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('data-tone'))),
          )
          .toEqual(testSessionCount === 1 ? ['working', 'idle'] : ['working', 'needs-input']);
        // The island hangs from the window's top edge, centered horizontally.
        await expect
          .poll(async () => {
            const box = await pill.boundingBox();
            const width = await page.evaluate(() => window.innerWidth);
            return box === null
              ? null
              : { top: box.y, centerOffset: Math.round(box.x + box.width / 2 - width / 2) };
          })
          .toEqual({ top: 0, centerOffset: 0 });
        expect(await page.evaluate(() => document.fonts.check('500 12px "Fira Code"'))).toBe(true);
        expect(
          await application.evaluate(
            ({ BaseWindow }) =>
              BaseWindow.getAllWindows().filter(
                (window) => window.getTitle() === 'Agent Status Tiles Dock Backdrop',
              ).length,
          ),
        ).toBe(0);
      }
    } finally {
      await closeApplication(application);
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
}

for (const testSessionCount of [1, 12]) {
  test(`keeps island hit regions bounded for ${String(testSessionCount)} synthetic sessions`, async () => {
    test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
    const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-island-region-e2e-'));
    let application: ElectronApplication | undefined;

    try {
      application = await launch(userDataDir, testSessionCount);
      await settingsWindow(application);
      const page = await overlayWindow(application);
      const pill = page.locator('.dynamic-island__pill');
      await expect(pill).toHaveCount(1);

      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      const box = await pill.boundingBox();
      if (box === null) throw new Error('The island has no bounds');
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBe(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

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

test('does not open Settings by itself at launch', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-quiet-launch-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir, 1);
    const overlay = await overlayWindow(application);
    await expect(overlay.locator('.dynamic-island__pill')).toHaveCount(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(findSettingsWindow(application)).toBeUndefined();

    await application.evaluate(({ app }) => {
      app.emit('activate');
    });
    await expect(settingsWindow(application)).resolves.toHaveTitle('Settings');
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

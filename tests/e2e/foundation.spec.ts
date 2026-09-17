import { expect, test, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeElectronE2eEnabled } from './native-focus';

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

    await expect(overlay.locator('.status-tiles__tile').first()).toBeFocused();
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

function findSettingsWindow(application: ElectronApplication): Page | undefined {
  return application.windows().find((window) => window.url().includes('/renderer/index.html'));
}

/**
 * Settings never opens by itself at launch; open it through a user activation.
 * The activation is re-sent while waiting because the app registers its
 * listener only once its runtime is ready.
 */
async function settingsWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  let lastActivation = 0;

  while (Date.now() < deadline) {
    const existingSettingsWindow = findSettingsWindow(application);
    if (existingSettingsWindow) {
      return existingSettingsWindow;
    }
    if (Date.now() - lastActivation >= 250) {
      lastActivation = Date.now();
      await application.evaluate(({ app }) => {
        app.emit('activate');
      });
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

test('wires production settings through preload, overlay state, and restart persistence', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-settings-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir, 1);
    const page = await settingsWindow(application);
    const overlay = await overlayWindow(application);

    await expect(page.getByRole('combobox', { name: 'Display' })).toContainText('Primary');
    await expect(page.getByRole('button', { name: 'Connect' })).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Connect' }).first()).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Connect' }).nth(1)).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Connect' }).nth(2)).toBeDisabled();
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
          y: Math.round(
            Math.min(
              Math.max(workArea.y + workArea.height / 3 - height / 2, workArea.y),
              workArea.y + workArea.height - height,
            ),
          ),
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
    await expect(replacement.locator('.status-tiles__tile')).toHaveCount(1);
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
    await expect(replacement.locator('.status-tiles__tile')).toHaveCount(1);
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

      const tiles = page.locator('.status-tiles__tile');
      await expect(tiles).toHaveCount(Math.min(testSessionCount, 12));
      if (testSessionCount === 0) {
        await expect(page.locator('.status-tiles')).toHaveCount(0);
      } else {
        await expect(page.getByRole('listbox', { name: 'Agent status sessions' })).toBeVisible();
        // Tabs fold into the right edge: only a 12px colored sliver stays on screen.
        // The real cursor may rest on the native overlay, which legitimately
        // reveals the icon depth (34px) or the whole hovered tab.
        const firstTab = page.locator('.status-tiles__tile').first();
        await expect
          .poll(async () => {
            const box = await firstTab.boundingBox();
            if (box === null) return 'missing';
            const width = await page.evaluate(() => window.innerWidth);
            const visible = Math.round(width - box.x);
            if (visible === 12) return 'folded';
            const cursor = await application!.evaluate(({ BrowserWindow, screen }) => {
              const overlay = BrowserWindow.getAllWindows().find((window) =>
                window.webContents.getURL().includes('/renderer/overlay.html'),
              );
              const bounds = overlay?.getBounds();
              const point = screen.getCursorScreenPoint();
              return bounds === undefined
                ? false
                : point.x >= bounds.x &&
                    point.x < bounds.x + bounds.width &&
                    point.y >= bounds.y &&
                    point.y < bounds.y + bounds.height;
            });
            const revealed = visible === 34 || visible === Math.round(box.width);
            return cursor && revealed ? 'revealed-under-cursor' : `unexpected:${String(visible)}`;
          })
          .toMatch(/^(?:folded|revealed-under-cursor)$/u);
        expect(
          await application.evaluate(
            ({ BaseWindow }) =>
              BaseWindow.getAllWindows().filter(
                (window) => window.getTitle() === 'Agent Status Tiles Dock Backdrop',
              ).length,
          ),
        ).toBe(0);
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
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      const foldedBox = await firstTile.boundingBox();
      if (foldedBox === null) throw new Error('First tab has no bounds');
      // Hover the visible sliver; the tab then slides fully into the window.
      await page.mouse.move(viewport.width - 6, foldedBox.y + foldedBox.height / 2);
      await expect(firstTile).toHaveAttribute('data-extended', 'true');
      await expect
        .poll(async () => {
          const box = await firstTile.boundingBox();
          return box === null ? null : Math.round((box.x + box.width - viewport.width) * 10) / 10;
        })
        .toBe(0);
      const extendedBox = await firstTile.boundingBox();
      if (extendedBox === null) throw new Error('Extended tab has no bounds');
      expect(extendedBox.x).toBeGreaterThanOrEqual(0);
      // Short titles fit on the tab, so no tooltip portal is needed.
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);

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

test('keeps an actionable native context menu reachable', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-menu-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir, 4);
    await settingsWindow(application);
    const page = await overlayWindow(application);
    const errorTile = page.locator('.status-tiles__tile[data-status="error"]');
    await expect(errorTile).toHaveCount(1);

    await errorTile.click({ button: 'right' });
    const dismissItem = page.getByRole('menuitem', { name: 'Dismiss error' });
    await expect(dismissItem).toBeEnabled();
    await dismissItem.click();
    await expect(dismissItem).toBeHidden();
  } finally {
    await closeApplication(application);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('does not open Settings by itself at launch', async () => {
  test.skip(process.platform !== 'darwin', 'the desktop shell targets macOS');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agent-status-tiles-quiet-launch-e2e-'));
  let application: ElectronApplication | undefined;

  try {
    application = await launch(userDataDir, 1);
    const overlay = await overlayWindow(application);
    await expect(overlay.locator('.status-tiles__tile')).toHaveCount(1);
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

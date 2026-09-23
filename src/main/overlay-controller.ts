import {
  BrowserWindow,
  app,
  powerMonitor,
  screen,
  type Display,
  type InputEvent,
  type MouseInputEvent,
  type Rectangle,
} from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { protectWebContents } from './security';
import { connectedDisplays, selectPreferredDisplay } from './display';
import { PRIMARY_DISPLAY_ID } from '../shared/settings';
import { MAX_OVERLAY_HIT_REGIONS, type OverlayHitRegion } from '../shared/overlay-ipc';

export { MAX_OVERLAY_HIT_REGIONS } from '../shared/overlay-ipc';
export type { OverlayHitRegion } from '../shared/overlay-ipc';

/**
 * The transparent native window hangs from the top center of the display and
 * leaves room around the compact island for its widest label and shadow.
 */
export const OVERLAY_WINDOW_WIDTH = 360;
export const OVERLAY_WINDOW_HEIGHT = 56;
export interface OverlayController {
  getWindow(): BrowserWindow | null;
  recover(): void;
  enterKeyboardMode(): void;
  /**
   * Leave keyboard mode. By default the previously active app comes back;
   * after navigation brought a harness forward, pass `restoreFocus: false`.
   */
  exitKeyboardMode(options?: { restoreFocus?: boolean }): void;
  setRendererReady(): void;
  setPreferredDisplayId(displayId: string): void;
  setQualifyingSessionCount(count: number): void;
  setVisible(visible: boolean): void;
  setHitRegions(regions: readonly OverlayHitRegion[]): boolean;
  destroy(): void;
}

/** The island hangs from the display's top edge, over the menu bar's empty center. */
export function overlayBounds(displayBounds: Rectangle): Rectangle {
  const width = Math.max(1, Math.min(OVERLAY_WINDOW_WIDTH, displayBounds.width));
  const height = Math.max(1, Math.min(OVERLAY_WINDOW_HEIGHT, displayBounds.height));

  return {
    x: Math.round(displayBounds.x + (displayBounds.width - width) / 2),
    y: displayBounds.y,
    width,
    height,
  };
}

export function isValidOverlayHitRegion(
  region: OverlayHitRegion,
  width = OVERLAY_WINDOW_WIDTH,
  height = OVERLAY_WINDOW_HEIGHT,
): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    Number.isFinite(region.x) &&
    Number.isFinite(region.y) &&
    Number.isFinite(region.width) &&
    Number.isFinite(region.height) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= width &&
    region.y + region.height <= height
  );
}

export function isPointInOverlayHitRegion(
  x: number,
  y: number,
  regions: readonly OverlayHitRegion[],
): boolean {
  return regions.some(
    (region) =>
      x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height,
  );
}

function rendererFilePath(): string {
  return join(__dirname, '../renderer/overlay.html');
}

function rendererUrl(): string {
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  if (developmentUrl) {
    return new URL(
      'overlay.html',
      developmentUrl.endsWith('/') ? developmentUrl : `${developmentUrl}/`,
    ).href;
  }

  return pathToFileURL(rendererFilePath()).href;
}

function createOverlayWindow(
  display: Display,
  onClosed: (window: BrowserWindow) => void,
  onRendererInvalidated: (window: BrowserWindow) => void,
  onRendererLoadFailed: (window: BrowserWindow) => void,
  onRendererGone: (window: BrowserWindow) => void,
  onPointerInput: (inputEvent: InputEvent) => void,
): BrowserWindow {
  const allowedUrl = rendererUrl();
  const window = new BrowserWindow({
    title: 'Agent Status Tiles Overlay',
    ...overlayBounds(display.bounds),
    enableLargerThanScreen: true,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    fullscreenable: false,
    roundedCorners: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      // The overlay never takes focus, so the turn-finished cue cannot wait
      // for a user gesture.
      autoplayPolicy: 'no-user-gesture-required',
      preload: join(__dirname, '../preload/overlay.js'),
    },
  });

  // Above the menu bar (level 24) so the island can sit over its empty center.
  window.setAlwaysOnTop(true, 'status');
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  window.setIgnoreMouseEvents(true, { forward: true });

  protectWebContents(window, allowedUrl);
  window.webContents.on('did-start-loading', () => onRendererInvalidated(window));
  window.webContents.on(
    'did-fail-load',
    (_event, _errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame) onRendererLoadFailed(window);
    },
  );
  window.webContents.on(
    'did-fail-provisional-load',
    (_event, _errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame) onRendererLoadFailed(window);
    },
  );
  window.webContents.on('render-process-gone', () => onRendererGone(window));
  window.webContents.on('input-event', (_event, inputEvent) => onPointerInput(inputEvent));
  window.on('closed', () => onClosed(window));

  const loadPromise = allowedUrl.startsWith('http')
    ? window.loadURL(allowedUrl)
    : window.loadFile(rendererFilePath());
  void loadPromise.catch((error: unknown) => {
    console.error('Unable to load overlay window', error);
    onRendererLoadFailed(window);
    if (!window.isDestroyed()) {
      window.destroy();
    }
    onClosed(window);
  });

  return window;
}

export interface OverlayControllerOptions {
  preferredDisplayId?: string;
  onKeyboardEntry?: () => boolean;
}

export function createOverlayController(options: OverlayControllerOptions = {}): OverlayController {
  let overlayWindow: BrowserWindow | null = null;
  let readyToShow = false;
  let requestedVisible = true;
  let hasQualifyingSessions = false;
  let keyboardMode = false;
  let keyboardEntryNotified = false;
  let keyboardWindowActivated = false;
  let rendererReady = false;
  let rendererWasReady = false;
  let preferredDisplayId = options.preferredDisplayId ?? PRIMARY_DISPLAY_ID;
  let hitRegions: readonly OverlayHitRegion[] = [];
  let ignoringMouseEvents = true;
  let isDestroyed = false;
  let generation = 0;
  let overlayGeneration = 0;
  const rendererLoadFailures = new WeakSet<BrowserWindow>();

  const resetRendererState = (): void => {
    readyToShow = false;
    rendererReady = false;
    rendererWasReady = false;
    ignoringMouseEvents = true;
    hitRegions = [];
  };

  const createWindow = (): void => {
    if (isDestroyed || overlayWindow) return;

    const nextGeneration = generation + 1;
    generation = nextGeneration;
    overlayGeneration = nextGeneration;
    resetRendererState();
    const window = createOverlayWindow(
      selectPreferredDisplay(preferredDisplayId, connectedDisplays(), screen.getPrimaryDisplay()),
      (closedWindow) => onClosed(closedWindow, nextGeneration),
      (invalidatedWindow) => onRendererInvalidated(invalidatedWindow, nextGeneration),
      (failedWindow) => onRendererLoadFailed(failedWindow, nextGeneration),
      (goneWindow) => onRendererGone(goneWindow, nextGeneration),
      (inputEvent) => onPointerInput(inputEvent, nextGeneration),
    );
    overlayWindow = window;
    window.once('ready-to-show', () => {
      if (
        isDestroyed ||
        overlayWindow !== window ||
        overlayGeneration !== nextGeneration ||
        window.isDestroyed()
      )
        return;
      readyToShow = true;
      syncVisibility();
    });
  };

  const reposition = (): void => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    const display = selectPreferredDisplay(
      preferredDisplayId,
      connectedDisplays(),
      screen.getPrimaryDisplay(),
    );
    const bounds = overlayBounds(display.bounds);
    overlayWindow.setBounds(bounds, false);
    const currentBounds = overlayWindow.getBounds();
    hitRegions = hitRegions.filter((region) =>
      isValidOverlayHitRegion(region, currentBounds.width, currentBounds.height),
    );
    syncMouseMode();
  };

  const syncVisibility = (): void => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    const shouldShow = requestedVisible && hasQualifyingSessions && readyToShow && rendererReady;
    if (shouldShow) {
      if (keyboardMode) {
        overlayWindow.setFocusable(true);
        if (!keyboardEntryNotified) {
          overlayWindow.show();
          app.focus({ steal: true });
          overlayWindow.focus();
          overlayWindow.webContents.focus();
          keyboardWindowActivated = true;
          if (rendererReady) {
            keyboardEntryNotified = options.onKeyboardEntry?.() ?? false;
          }
        } else if (!overlayWindow.isVisible()) {
          overlayWindow.show();
        }
      } else {
        overlayWindow.setFocusable(false);
        if (!overlayWindow.isVisible()) overlayWindow.showInactive();
      }
    } else if (overlayWindow.isVisible()) {
      overlayWindow.hide();
      overlayWindow.setFocusable(false);
      keyboardEntryNotified = false;
    } else {
      overlayWindow.setFocusable(false);
      keyboardEntryNotified = false;
    }
    syncMouseMode();
  };

  const reapplyMousePassthrough = (): void => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    ignoringMouseEvents = true;
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    syncMouseMode();
  };

  const setMouseIgnoring = (ignore: boolean): void => {
    if (!overlayWindow || overlayWindow.isDestroyed() || ignoringMouseEvents === ignore) {
      return;
    }

    ignoringMouseEvents = ignore;
    overlayWindow.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
  };

  const syncMouseMode = (): void => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    if (!overlayWindow.isVisible() || hitRegions.length === 0) {
      setMouseIgnoring(true);
      return;
    }

    const bounds = overlayWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    setMouseIgnoring(
      !isPointInOverlayHitRegion(cursor.x - bounds.x, cursor.y - bounds.y, hitRegions),
    );
  };

  const leaveKeyboardMode = (): boolean => {
    const shouldDeactivate = keyboardWindowActivated;
    keyboardMode = false;
    keyboardEntryNotified = false;
    keyboardWindowActivated = false;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.blur();
      overlayWindow.setFocusable(false);
    }
    return shouldDeactivate;
  };

  const restorePreviousApplication = (
    shouldDeactivate: boolean,
    keepOverlayVisible: boolean,
  ): void => {
    if (!shouldDeactivate || process.platform !== 'darwin') return;
    app.hide();
    app.show();
    if (keepOverlayVisible && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.showInactive();
    }
  };

  const onPointerInput = (inputEvent: InputEvent, callbackGeneration?: number): void => {
    if (
      callbackGeneration !== undefined &&
      (callbackGeneration !== overlayGeneration || callbackGeneration !== generation)
    ) {
      return;
    }
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    if (!overlayWindow.isVisible()) {
      setMouseIgnoring(true);
      return;
    }

    if (inputEvent.type === 'mouseLeave') {
      setMouseIgnoring(true);
      return;
    }

    if (inputEvent.type !== 'mouseMove' && inputEvent.type !== 'mouseEnter') {
      return;
    }

    const mouseInput = inputEvent as MouseInputEvent;
    setMouseIgnoring(!isPointInOverlayHitRegion(mouseInput.x, mouseInput.y, hitRegions));
  };

  const onClosed = (window: BrowserWindow, callbackGeneration?: number): void => {
    if (
      isDestroyed ||
      overlayWindow !== window ||
      (callbackGeneration !== undefined &&
        (callbackGeneration !== overlayGeneration || callbackGeneration !== generation))
    ) {
      return;
    }

    const failedToLoad = rendererLoadFailures.has(window);
    const shouldDeactivate = leaveKeyboardMode();
    overlayWindow = null;
    overlayGeneration = 0;
    resetRendererState();
    restorePreviousApplication(shouldDeactivate, false);
    if (!failedToLoad) {
      recoverOverlay();
    }
  };

  const onRendererInvalidated = (window: BrowserWindow, callbackGeneration?: number): void => {
    if (
      isDestroyed ||
      overlayWindow !== window ||
      (callbackGeneration !== undefined &&
        (callbackGeneration !== overlayGeneration || callbackGeneration !== generation))
    )
      return;
    rendererReady = false;
    keyboardEntryNotified = false;
    hitRegions = [];
    if (overlayWindow.isVisible()) {
      overlayWindow.hide();
      overlayWindow.setFocusable(false);
    }
    reapplyMousePassthrough();
  };

  const onRendererLoadFailed = (window: BrowserWindow, callbackGeneration?: number): void => {
    if (
      isDestroyed ||
      overlayWindow !== window ||
      (callbackGeneration !== undefined &&
        (callbackGeneration !== overlayGeneration || callbackGeneration !== generation))
    )
      return;
    if (rendererWasReady) {
      onRendererGone(window, callbackGeneration);
      return;
    }
    rendererLoadFailures.add(window);
    rendererReady = false;
    keyboardEntryNotified = false;
    hitRegions = [];
    reapplyMousePassthrough();
    if (!window.isDestroyed()) window.destroy();
    onClosed(window, callbackGeneration);
  };

  const onRendererGone = (window: BrowserWindow, callbackGeneration?: number): void => {
    if (
      isDestroyed ||
      overlayWindow !== window ||
      (callbackGeneration !== undefined &&
        (callbackGeneration !== overlayGeneration || callbackGeneration !== generation))
    )
      return;
    rendererReady = false;
    keyboardEntryNotified = false;
    hitRegions = [];
    reapplyMousePassthrough();
    if (!window.isDestroyed()) window.destroy();
    onClosed(window, callbackGeneration);
  };

  const recoverOverlay = (repositionExisting = true): void => {
    if (isDestroyed) return;
    if (overlayWindow?.isDestroyed()) {
      onClosed(overlayWindow, overlayGeneration);
      return;
    }
    if (overlayWindow?.webContents.isCrashed()) {
      onRendererGone(overlayWindow, overlayGeneration);
      return;
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (repositionExisting) reposition();
      return;
    }
    if (!requestedVisible || !hasQualifyingSessions) return;
    createWindow();
  };
  const recoverFromLifecycle = (): void => recoverOverlay();

  createWindow();

  screen.on('display-metrics-changed', recoverFromLifecycle);
  screen.on('display-added', recoverFromLifecycle);
  screen.on('display-removed', recoverFromLifecycle);
  powerMonitor.on('resume', recoverFromLifecycle);

  return {
    getWindow: () => {
      if (overlayWindow?.isDestroyed()) {
        onClosed(overlayWindow);
      }

      return overlayWindow;
    },
    enterKeyboardMode: () => {
      requestedVisible = true;
      if (!hasQualifyingSessions) return;
      keyboardMode = true;
      keyboardEntryNotified = false;
      syncVisibility();
    },
    exitKeyboardMode: (exitOptions) => {
      // After a mouse click there is no keyboard mode to leave; blurring and
      // re-ordering the window then would only disturb the island.
      if (exitOptions?.restoreFocus === false && !keyboardMode && !keyboardWindowActivated) return;
      const shouldDeactivate = leaveKeyboardMode();
      syncVisibility();
      reapplyMousePassthrough();
      if (exitOptions?.restoreFocus === false) return;
      restorePreviousApplication(shouldDeactivate, overlayWindow?.isVisible() ?? false);
    },
    setRendererReady: () => {
      if (isDestroyed || !overlayWindow || overlayWindow.isDestroyed() || rendererReady) return;
      rendererReady = true;
      rendererWasReady = true;
      syncVisibility();
    },
    setPreferredDisplayId: (displayId) => {
      preferredDisplayId = displayId;
      reposition();
    },
    setQualifyingSessionCount: (count) => {
      hasQualifyingSessions = Number.isFinite(count) && count > 0;
      let shouldDeactivate = false;
      if (hasQualifyingSessions) {
        recoverOverlay(false);
      } else {
        shouldDeactivate = leaveKeyboardMode();
      }
      syncVisibility();
      if (!hasQualifyingSessions) reapplyMousePassthrough();
      restorePreviousApplication(shouldDeactivate, false);
    },
    setVisible: (visible) => {
      const shouldDeactivate = visible ? false : leaveKeyboardMode();
      if (!visible) {
        keyboardEntryNotified = false;
      }
      requestedVisible = visible;
      if (requestedVisible) recoverOverlay(false);
      syncVisibility();
      if (!visible) reapplyMousePassthrough();
      restorePreviousApplication(shouldDeactivate, false);
    },
    setHitRegions: (regions) => {
      if (isDestroyed || !overlayWindow || overlayWindow.isDestroyed()) {
        hitRegions = [];
        return false;
      }

      const bounds = overlayWindow.getBounds();
      const valid =
        regions.length <= MAX_OVERLAY_HIT_REGIONS &&
        regions.every((region) => isValidOverlayHitRegion(region, bounds.width, bounds.height));
      hitRegions = valid ? regions.map((region) => ({ ...region })) : [];
      syncMouseMode();
      return valid;
    },
    destroy: () => {
      if (isDestroyed) return;
      isDestroyed = true;
      keyboardMode = false;
      keyboardWindowActivated = false;
      screen.off('display-added', recoverFromLifecycle);
      screen.off('display-removed', recoverFromLifecycle);
      screen.off('display-metrics-changed', recoverFromLifecycle);
      powerMonitor.off('resume', recoverFromLifecycle);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
      }
      overlayWindow = null;
      readyToShow = false;
      rendererReady = false;
      keyboardEntryNotified = false;
      ignoringMouseEvents = true;
      hitRegions = [];
    },
    recover: recoverOverlay,
  };
}

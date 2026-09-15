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
 * The transparent native window includes room for the stock tooltip and
 * context menu. StatusTiles keeps its own 88px right-aligned strip inside it.
 */
export const OVERLAY_WINDOW_WIDTH = 360;
export const OVERLAY_WINDOW_HEIGHT = 480;
export interface OverlayController {
  getWindow(): BrowserWindow | null;
  setPreferredDisplayId(displayId: string): void;
  setQualifyingSessionCount(count: number): void;
  setVisible(visible: boolean): void;
  setHitRegions(regions: readonly OverlayHitRegion[]): boolean;
  destroy(): void;
}

export function overlayBounds(workArea: Rectangle): Rectangle {
  const width = Math.max(1, Math.min(OVERLAY_WINDOW_WIDTH, workArea.width));
  const height = Math.max(1, Math.min(OVERLAY_WINDOW_HEIGHT, workArea.height));

  return {
    x: Math.round(workArea.x + workArea.width - width),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
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
  onPointerInput: (inputEvent: InputEvent) => void,
): BrowserWindow {
  const allowedUrl = rendererUrl();
  const window = new BrowserWindow({
    title: 'Agent Status Tiles Overlay',
    ...overlayBounds(display.workArea),
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
      preload: join(__dirname, '../preload/overlay.js'),
    },
  });

  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  window.setIgnoreMouseEvents(true, { forward: true });

  protectWebContents(window, allowedUrl);
  window.webContents.on('input-event', (_event, inputEvent) => onPointerInput(inputEvent));
  window.on('closed', () => onClosed(window));

  const loadPromise = allowedUrl.startsWith('http')
    ? window.loadURL(allowedUrl)
    : window.loadFile(rendererFilePath());
  void loadPromise.catch((error: unknown) => {
    console.error('Unable to load overlay window', error);
    if (!window.isDestroyed()) {
      window.destroy();
    }
    onClosed(window);
  });

  return window;
}

export interface OverlayControllerOptions {
  preferredDisplayId?: string;
}

export function createOverlayController(options: OverlayControllerOptions = {}): OverlayController {
  let overlayWindow: BrowserWindow | null = null;
  let readyToShow = false;
  let requestedVisible = true;
  let hasQualifyingSessions = false;
  let preferredDisplayId = options.preferredDisplayId ?? PRIMARY_DISPLAY_ID;
  let hitRegions: readonly OverlayHitRegion[] = [];
  let ignoringMouseEvents = true;
  let isDestroyed = false;

  const createWindow = (): void => {
    if (isDestroyed || overlayWindow) return;

    readyToShow = false;
    ignoringMouseEvents = true;
    hitRegions = [];
    const window = createOverlayWindow(
      selectPreferredDisplay(preferredDisplayId, connectedDisplays(), screen.getPrimaryDisplay()),
      onClosed,
      onPointerInput,
    );
    overlayWindow = window;
    window.once('ready-to-show', () => {
      if (isDestroyed || overlayWindow !== window || window.isDestroyed()) return;
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
    const bounds = overlayBounds(display.workArea);
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

    const shouldShow = requestedVisible && hasQualifyingSessions && readyToShow;
    if (shouldShow) {
      overlayWindow.showInactive();
    } else if (overlayWindow.isVisible()) {
      overlayWindow.hide();
    }
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

  const onPointerInput = (inputEvent: InputEvent): void => {
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

  const onClosed = (window: BrowserWindow): void => {
    if (overlayWindow === window) {
      overlayWindow = null;
      readyToShow = false;
      ignoringMouseEvents = true;
      hitRegions = [];
    }
  };

  createWindow();

  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
  powerMonitor.on('resume', reposition);

  return {
    getWindow: () => {
      if (overlayWindow?.isDestroyed()) {
        onClosed(overlayWindow);
      }

      return overlayWindow;
    },
    setPreferredDisplayId: (displayId) => {
      preferredDisplayId = displayId;
      reposition();
    },
    setQualifyingSessionCount: (count) => {
      hasQualifyingSessions = Number.isFinite(count) && count > 0;
      if (hasQualifyingSessions) createWindow();
      syncVisibility();
    },
    setVisible: (visible) => {
      requestedVisible = visible;
      if (requestedVisible) createWindow();
      syncVisibility();
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
      screen.off('display-metrics-changed', reposition);
      screen.off('display-added', reposition);
      screen.off('display-removed', reposition);
      powerMonitor.off('resume', reposition);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
      }
      overlayWindow = null;
      readyToShow = false;
      ignoringMouseEvents = true;
      hitRegions = [];
    },
  };
}

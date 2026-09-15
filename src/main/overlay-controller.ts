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

import { isAllowedRendererNavigation } from './security';

export const OVERLAY_WINDOW_WIDTH = 88;
export const OVERLAY_WINDOW_HEIGHT = 480;
export const MAX_OVERLAY_HIT_REGIONS = 12;

export interface OverlayHitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayController {
  getWindow(): BrowserWindow | null;
  setQualifyingSessionCount(count: number): void;
  setVisible(visible: boolean): void;
  setHitRegions(regions: readonly OverlayHitRegion[]): boolean;
  destroy(): void;
}

export function overlayBounds(workArea: Rectangle): Rectangle {
  const height = Math.max(1, Math.min(OVERLAY_WINDOW_HEIGHT, workArea.height));

  return {
    x: Math.round(workArea.x + workArea.width - OVERLAY_WINDOW_WIDTH),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width: OVERLAY_WINDOW_WIDTH,
    height,
  };
}

export function isValidOverlayHitRegion(region: OverlayHitRegion): boolean {
  return (
    Number.isFinite(region.x) &&
    Number.isFinite(region.y) &&
    Number.isFinite(region.width) &&
    Number.isFinite(region.height) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= OVERLAY_WINDOW_WIDTH &&
    region.y + region.height <= OVERLAY_WINDOW_HEIGHT
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

function protectWebContents(window: BrowserWindow, allowedUrl: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, allowedUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-redirect', (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, allowedUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
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
  });

  return window;
}

export function createOverlayController(): OverlayController {
  let overlayWindow: BrowserWindow | null = null;
  let readyToShow = false;
  let requestedVisible = true;
  let hasQualifyingSessions = false;
  let hitRegions: readonly OverlayHitRegion[] = [];
  let ignoringMouseEvents = true;

  const reposition = (): void => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    overlayWindow.setBounds(overlayBounds(screen.getPrimaryDisplay().workArea), false);
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
    }
  };

  overlayWindow = createOverlayWindow(screen.getPrimaryDisplay(), onClosed, onPointerInput);
  overlayWindow.once('ready-to-show', () => {
    readyToShow = true;
    syncVisibility();
  });

  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
  powerMonitor.on('resume', reposition);

  return {
    getWindow: () => {
      if (overlayWindow?.isDestroyed()) {
        overlayWindow = null;
        readyToShow = false;
      }

      return overlayWindow;
    },
    setQualifyingSessionCount: (count) => {
      hasQualifyingSessions = Number.isFinite(count) && count > 0;
      syncVisibility();
    },
    setVisible: (visible) => {
      requestedVisible = visible;
      syncVisibility();
    },
    setHitRegions: (regions) => {
      const valid =
        regions.length <= MAX_OVERLAY_HIT_REGIONS && regions.every(isValidOverlayHitRegion);
      hitRegions = valid ? regions.map((region) => ({ ...region })) : [];
      syncMouseMode();
      return valid;
    },
    destroy: () => {
      screen.off('display-metrics-changed', reposition);
      screen.off('display-added', reposition);
      screen.off('display-removed', reposition);
      powerMonitor.off('resume', reposition);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
      }
      overlayWindow = null;
    },
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PointerEvent = {
  type: 'mouseEnter' | 'mouseLeave' | 'mouseMove';
  x: number;
  y: number;
};

type OverlayWindowMock = {
  destroy: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  readyListener?: () => void;
  pointerListener?: (inputEvent: PointerEvent) => void;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
  };
};

const electronMocks = vi.hoisted(() => ({
  BrowserWindow: vi.fn(),
  app: { isPackaged: true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 24, width: 1440, height: 876 } })),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('electron', () => electronMocks);

function createOverlayWindowMock(): OverlayWindowMock {
  let visible = false;
  const mock: OverlayWindowMock = {
    destroy: vi.fn(),
    hide: vi.fn(() => {
      visible = false;
    }),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => visible),
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setBounds: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    showInactive: vi.fn(() => {
      visible = true;
    }),
    webContents: {
      on: vi.fn((event: string, callback: unknown) => {
        if (event === 'input-event') {
          const inputCallback = callback as (event: unknown, inputEvent: PointerEvent) => void;
          mock.pointerListener = (inputEvent) => inputCallback(undefined, inputEvent);
        }
      }),
      setWindowOpenHandler: vi.fn(),
    },
  };

  const once = vi.fn((event: string, callback: unknown) => {
    if (event === 'ready-to-show') {
      mock.readyListener = callback as () => void;
    }
  });
  const on = vi.fn();
  Object.assign(mock, { once, on });
  return mock;
}

function mockOverlayWindow(window: OverlayWindowMock): void {
  electronMocks.BrowserWindow.mockImplementation(
    class BrowserWindowMock {
      constructor() {
        return window;
      }
    } as unknown as typeof electronMocks.BrowserWindow,
  );
}

describe('overlay controller', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMocks.BrowserWindow.mockReset();
    electronMocks.screen.getPrimaryDisplay.mockClear();
    electronMocks.screen.on.mockClear();
    electronMocks.screen.off.mockClear();
    electronMocks.powerMonitor.on.mockClear();
    electronMocks.powerMonitor.off.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a transparent nonactivating window centered in the primary work area', async () => {
    const overlayWindow = createOverlayWindowMock();
    mockOverlayWindow(overlayWindow);
    const { createOverlayController } = await import('../../src/main/overlay-controller');

    const controller = createOverlayController();
    const options = electronMocks.BrowserWindow.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(options).toMatchObject({
      x: 1352,
      y: 222,
      width: 88,
      height: 480,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      show: false,
    });
    expect(options).not.toHaveProperty('minWidth');
    expect(options).not.toHaveProperty('minHeight');
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect(overlayWindow.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(overlayWindow.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      skipTransformProcessType: true,
      visibleOnFullScreen: true,
    });
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(overlayWindow.showInactive).not.toHaveBeenCalled();

    overlayWindow.readyListener?.();
    controller.setQualifyingSessionCount(1);
    expect(overlayWindow.showInactive).toHaveBeenCalledOnce();
    controller.setQualifyingSessionCount(0);
    expect(overlayWindow.hide).toHaveBeenCalledOnce();
    controller.destroy();
    expect(overlayWindow.destroy).toHaveBeenCalledOnce();
  });

  it('toggles native passthrough only for bounded hit regions', async () => {
    const overlayWindow = createOverlayWindowMock();
    mockOverlayWindow(overlayWindow);
    const {
      MAX_OVERLAY_HIT_REGIONS,
      createOverlayController,
      isPointInOverlayHitRegion,
      isValidOverlayHitRegion,
    } = await import('../../src/main/overlay-controller');
    const controller = createOverlayController();

    expect(isValidOverlayHitRegion({ x: 10, y: 20, width: 24, height: 24 })).toBe(true);
    expect(isValidOverlayHitRegion({ x: 80, y: 20, width: 10, height: 24 })).toBe(false);
    expect(isPointInOverlayHitRegion(12, 22, [{ x: 10, y: 20, width: 24, height: 24 }])).toBe(true);
    expect(isPointInOverlayHitRegion(34, 22, [{ x: 10, y: 20, width: 24, height: 24 }])).toBe(
      false,
    );
    expect(
      controller.setHitRegions(
        Array.from({ length: MAX_OVERLAY_HIT_REGIONS + 1 }, () => ({
          x: 10,
          y: 20,
          width: 24,
          height: 24,
        })),
      ),
    ).toBe(false);
    expect(controller.setHitRegions([{ x: 10, y: 20, width: 24, height: 24 }])).toBe(true);

    overlayWindow.pointerListener?.({ type: 'mouseMove', x: 12, y: 22 });
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(false, undefined);
    overlayWindow.pointerListener?.({ type: 'mouseMove', x: 34, y: 22 });
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    overlayWindow.pointerListener?.({ type: 'mouseLeave', x: 34, y: 22 });
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenCalledTimes(3);
    controller.destroy();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PointerEvent = {
  type: 'mouseEnter' | 'mouseLeave' | 'mouseMove';
  x: number;
  y: number;
};

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type OverlayWindowMock = {
  destroy: ReturnType<typeof vi.fn>;
  blur: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
  isFocusable: ReturnType<typeof vi.fn> & (() => boolean);
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  moveAbove: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  setFocusable: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  readyListener?: () => void;
  closedListener?: () => void;
  loadingListener?: () => void;
  failedLoadListener?: () => void;
  rendererGoneListener?: () => void;
  pointerListener?: (inputEvent: PointerEvent) => void;
  markDestroyed: () => void;
  webContents: {
    focus: ReturnType<typeof vi.fn>;
    isCrashed: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
  };
};

const electronMocks = vi.hoisted(() => ({
  BaseWindow: vi.fn(),
  BrowserWindow: vi.fn(),
  app: { focus: vi.fn(), hide: vi.fn(), isPackaged: true, show: vi.fn() },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 24, width: 1440, height: 876 },
      },
    ]),
    getPrimaryDisplay: vi.fn(() => ({
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 24, width: 1440, height: 876 },
    })),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('electron', () => electronMocks);

function createOverlayWindowMock(
  initialBounds: Bounds = { x: 1080, y: 76, width: 360, height: 480 },
): OverlayWindowMock {
  let visible = false;
  let focusable = false;
  let destroyed = false;
  let bounds = initialBounds;
  const mock: OverlayWindowMock = {
    blur: vi.fn(),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    focus: vi.fn(),
    hide: vi.fn(() => {
      visible = false;
    }),
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    isFocusable: vi.fn(() => focusable),
    getBounds: vi.fn(() => bounds),
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(),
    moveAbove: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setBounds: vi.fn((nextBounds: Bounds) => {
      bounds = nextBounds;
    }),
    setFocusable: vi.fn((nextFocusable: boolean) => {
      focusable = nextFocusable;
    }),
    setIgnoreMouseEvents: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    show: vi.fn(() => {
      visible = true;
      focusable = true;
    }),
    showInactive: vi.fn(() => {
      visible = true;
      focusable = false;
    }),
    webContents: {
      focus: vi.fn(),
      isCrashed: vi.fn(() => false),
      on: vi.fn((event: string, callback: unknown) => {
        if (event === 'did-start-loading') {
          mock.loadingListener = callback as () => void;
        }
        if (event === 'input-event') {
          const inputCallback = callback as (event: unknown, inputEvent: PointerEvent) => void;
          mock.pointerListener = (inputEvent) => inputCallback(undefined, inputEvent);
        }
        if (event === 'render-process-gone') {
          mock.rendererGoneListener = callback as () => void;
        }
        if (event === 'did-fail-load' || event === 'did-fail-provisional-load') {
          const failedLoadCallback = callback as (
            event: unknown,
            errorCode: number,
            errorDescription: string,
            validatedUrl: string,
            isMainFrame: boolean,
          ) => void;
          mock.failedLoadListener = () =>
            failedLoadCallback(undefined, -3, 'aborted', 'file:///overlay.html', true);
        }
      }),
      setWindowOpenHandler: vi.fn(),
    },
    markDestroyed: () => {
      destroyed = true;
    },
  };

  mock.setFocusable.mockImplementation((nextFocusable: boolean) => {
    focusable = nextFocusable;
  });
  const once = vi.fn((event: string, callback: unknown) => {
    if (event === 'ready-to-show') {
      mock.readyListener = callback as () => void;
    }
  });
  const on = vi.fn((event: string, callback: unknown) => {
    if (event === 'closed') mock.closedListener = callback as () => void;
  });
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
    electronMocks.app.focus.mockClear();
    electronMocks.app.hide.mockClear();
    electronMocks.app.show.mockClear();
    electronMocks.screen.getAllDisplays.mockReset();
    electronMocks.screen.getAllDisplays.mockReturnValue([
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 24, width: 1440, height: 876 },
      },
    ]);
    electronMocks.screen.getPrimaryDisplay.mockReset();
    electronMocks.screen.getPrimaryDisplay.mockReturnValue({
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 24, width: 1440, height: 876 },
    });
    electronMocks.screen.getCursorScreenPoint.mockClear();
    electronMocks.screen.on.mockClear();
    electronMocks.screen.off.mockClear();
    electronMocks.powerMonitor.on.mockClear();
    electronMocks.powerMonitor.off.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a transparent nonactivating window at the top center of the primary display', async () => {
    const overlayWindow = createOverlayWindowMock();
    mockOverlayWindow(overlayWindow);
    const { createOverlayController } = await import('../../src/main/overlay-controller');

    const controller = createOverlayController();
    const options = electronMocks.BrowserWindow.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(options).toMatchObject({
      x: 540,
      y: 0,
      width: 360,
      height: 56,
      enableLargerThanScreen: true,
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
      autoplayPolicy: 'no-user-gesture-required',
    });
    expect(overlayWindow.setAlwaysOnTop).toHaveBeenCalledWith(true, 'status');
    expect(overlayWindow.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      skipTransformProcessType: true,
      visibleOnFullScreen: true,
    });
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(overlayWindow.showInactive).not.toHaveBeenCalled();

    controller.setRendererReady();
    overlayWindow.readyListener?.();
    controller.setQualifyingSessionCount(1);
    expect(overlayWindow.showInactive).toHaveBeenCalledOnce();
    controller.setQualifyingSessionCount(0);
    expect(overlayWindow.hide).toHaveBeenCalledOnce();
    controller.destroy();
    expect(overlayWindow.destroy).toHaveBeenCalledOnce();
  });

  it('enters keyboard mode only through explicit requests and safely refocuses', async () => {
    const overlayWindow = createOverlayWindowMock();
    mockOverlayWindow(overlayWindow);
    const onKeyboardEntry = vi.fn(() => true);
    const { createOverlayController } = await import('../../src/main/overlay-controller');

    const controller = createOverlayController({ onKeyboardEntry });
    controller.setRendererReady();
    overlayWindow.readyListener?.();
    controller.setQualifyingSessionCount(1);
    expect(overlayWindow.showInactive).toHaveBeenCalledOnce();
    expect(overlayWindow.show).not.toHaveBeenCalled();
    expect(overlayWindow.focus).not.toHaveBeenCalled();
    expect(overlayWindow.isFocusable()).toBe(false);

    controller.enterKeyboardMode();
    expect(overlayWindow.setFocusable).toHaveBeenLastCalledWith(true);
    expect(overlayWindow.show).toHaveBeenCalledOnce();
    expect(electronMocks.app.focus).toHaveBeenCalledWith({ steal: true });
    expect(overlayWindow.focus).toHaveBeenCalledOnce();
    expect(onKeyboardEntry).toHaveBeenCalledOnce();
    expect(overlayWindow.isFocusable()).toBe(true);

    controller.enterKeyboardMode();
    expect(overlayWindow.show).toHaveBeenCalledTimes(2);
    expect(overlayWindow.focus).toHaveBeenCalledTimes(2);
    expect(onKeyboardEntry).toHaveBeenCalledTimes(2);
    controller.setRendererReady();
    expect(overlayWindow.focus).toHaveBeenCalledTimes(2);
    expect(onKeyboardEntry).toHaveBeenCalledTimes(2);

    overlayWindow.loadingListener?.();
    controller.enterKeyboardMode();
    expect(overlayWindow.focus).toHaveBeenCalledTimes(2);
    expect(onKeyboardEntry).toHaveBeenCalledTimes(2);
    controller.setRendererReady();
    expect(overlayWindow.focus).toHaveBeenCalledTimes(3);
    expect(onKeyboardEntry).toHaveBeenCalledTimes(3);
    controller.exitKeyboardMode();
    expect(overlayWindow.blur).toHaveBeenCalledOnce();
    expect(overlayWindow.setFocusable).toHaveBeenLastCalledWith(false);
    expect(overlayWindow.showInactive).toHaveBeenCalledTimes(2);
    expect(overlayWindow.isFocusable()).toBe(false);
    expect(electronMocks.app.hide).toHaveBeenCalledOnce();
    expect(electronMocks.app.show).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('queues keyboard entry until a ready overlay has a qualifying session', async () => {
    const overlayWindow = createOverlayWindowMock();
    mockOverlayWindow(overlayWindow);
    const onKeyboardEntry = vi.fn(() => true);
    const { createOverlayController } = await import('../../src/main/overlay-controller');

    const controller = createOverlayController({ onKeyboardEntry });
    controller.setQualifyingSessionCount(1);
    controller.enterKeyboardMode();
    expect(overlayWindow.show).not.toHaveBeenCalled();
    expect(onKeyboardEntry).not.toHaveBeenCalled();

    overlayWindow.readyListener?.();
    expect(overlayWindow.show).not.toHaveBeenCalled();
    expect(overlayWindow.focus).not.toHaveBeenCalled();
    expect(onKeyboardEntry).not.toHaveBeenCalled();

    controller.setRendererReady();
    expect(overlayWindow.show).toHaveBeenCalledOnce();
    expect(overlayWindow.focus).toHaveBeenCalledOnce();
    expect(onKeyboardEntry).toHaveBeenCalledOnce();

    controller.setQualifyingSessionCount(0);
    expect(overlayWindow.hide).toHaveBeenCalledOnce();
    expect(overlayWindow.isFocusable()).toBe(false);
    expect(electronMocks.app.hide).toHaveBeenCalledOnce();
    expect(electronMocks.app.show).toHaveBeenCalledOnce();
    controller.setQualifyingSessionCount(1);
    expect(overlayWindow.focus).toHaveBeenCalledOnce();
    expect(overlayWindow.showInactive).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('does not arm future focus when Show is requested without sessions', async () => {
    const overlayWindow = createOverlayWindowMock();
    mockOverlayWindow(overlayWindow);
    const onKeyboardEntry = vi.fn(() => true);
    const { createOverlayController } = await import('../../src/main/overlay-controller');

    const controller = createOverlayController({ onKeyboardEntry });
    controller.setRendererReady();
    overlayWindow.readyListener?.();
    controller.enterKeyboardMode();
    controller.setQualifyingSessionCount(1);

    expect(overlayWindow.show).not.toHaveBeenCalled();
    expect(overlayWindow.focus).not.toHaveBeenCalled();
    expect(onKeyboardEntry).not.toHaveBeenCalled();
    expect(overlayWindow.showInactive).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('exits keyboard mode before hiding and restores passthrough', async () => {
    const overlayWindow = createOverlayWindowMock();
    mockOverlayWindow(overlayWindow);
    const { createOverlayController } = await import('../../src/main/overlay-controller');

    const controller = createOverlayController();
    controller.setRendererReady();
    overlayWindow.readyListener?.();
    controller.setQualifyingSessionCount(1);
    controller.enterKeyboardMode();
    controller.setHitRegions([{ x: 10, y: 20, width: 24, height: 24 }]);
    controller.setVisible(false);

    expect(overlayWindow.blur).toHaveBeenCalledOnce();
    expect(overlayWindow.setFocusable).toHaveBeenLastCalledWith(false);
    expect(overlayWindow.hide).toHaveBeenCalledOnce();
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(electronMocks.app.hide).toHaveBeenCalledOnce();
    expect(electronMocks.app.show).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('tears down keyboard mode and recreates once when the native window closes', async () => {
    const firstWindow = createOverlayWindowMock();
    const secondWindow = createOverlayWindowMock();
    electronMocks.BrowserWindow.mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return firstWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    ).mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return secondWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    );
    const { createOverlayController } = await import('../../src/main/overlay-controller');
    const controller = createOverlayController({ onKeyboardEntry: () => true });

    controller.setRendererReady();
    firstWindow.readyListener?.();
    controller.setQualifyingSessionCount(1);
    controller.enterKeyboardMode();
    firstWindow.closedListener?.();

    expect(controller.getWindow()).toBe(secondWindow);
    expect(electronMocks.app.hide).toHaveBeenCalledOnce();
    expect(electronMocks.app.show).toHaveBeenCalledOnce();
    secondWindow.readyListener?.();
    expect(secondWindow.showInactive).not.toHaveBeenCalled();
    expect(secondWindow.show).not.toHaveBeenCalled();
    expect(secondWindow.focus).not.toHaveBeenCalled();
    controller.setRendererReady();
    expect(secondWindow.showInactive).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('recreates a failed renderer only after a later qualifying-session update', async () => {
    const failedWindow = createOverlayWindowMock();
    failedWindow.loadFile.mockReturnValueOnce(Promise.reject(new Error('renderer unavailable')));
    const recoveredWindow = createOverlayWindowMock();
    electronMocks.BrowserWindow.mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return failedWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    ).mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return recoveredWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createOverlayController } = await import('../../src/main/overlay-controller');

    const controller = createOverlayController();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(failedWindow.destroy).toHaveBeenCalledOnce();
    expect(controller.getWindow()).toBeNull();

    controller.setQualifyingSessionCount(1);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
    failedWindow.readyListener?.();
    expect(recoveredWindow.showInactive).not.toHaveBeenCalled();
    recoveredWindow.readyListener?.();
    controller.setRendererReady();
    expect(recoveredWindow.showInactive).toHaveBeenCalledOnce();

    const resume = electronMocks.powerMonitor.on.mock.calls.find(
      ([event]) => event === 'resume',
    )?.[1] as (() => void) | undefined;
    resume?.();
    expect(recoveredWindow.setBounds).toHaveBeenCalledWith(
      { x: 540, y: 0, width: 360, height: 56 },
      false,
    );

    controller.destroy();
    expect(electronMocks.powerMonitor.off).toHaveBeenCalledWith('resume', resume);
    controller.setVisible(true);
    controller.setQualifyingSessionCount(1);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it('uses the preferred connected display, falls back while absent, and restores on reconnect', async () => {
    const primary = {
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 24, width: 1440, height: 876 },
    };
    const external = {
      id: 42,
      bounds: { x: -1200, y: -200, width: 1200, height: 900 },
      workArea: { x: -1200, y: -175, width: 1200, height: 875 },
    };
    electronMocks.screen.getPrimaryDisplay.mockReturnValue(primary);
    electronMocks.screen.getAllDisplays.mockReturnValue([primary]);
    const overlayWindow = createOverlayWindowMock();
    mockOverlayWindow(overlayWindow);
    const { createOverlayController } = await import('../../src/main/overlay-controller');

    const controller = createOverlayController({ preferredDisplayId: '42' });
    expect(electronMocks.BrowserWindow.mock.calls[0]?.[0]).toMatchObject({
      x: 540,
      y: 0,
      width: 360,
      height: 56,
    });

    electronMocks.screen.getAllDisplays.mockReturnValue([primary, external]);
    const onAdded = electronMocks.screen.on.mock.calls.find(
      ([event]) => event === 'display-added',
    )?.[1] as (() => void) | undefined;
    onAdded?.();
    expect(overlayWindow.setBounds).toHaveBeenLastCalledWith(
      { x: -780, y: -200, width: 360, height: 56 },
      false,
    );

    controller.setPreferredDisplayId('primary');
    expect(overlayWindow.setBounds).toHaveBeenLastCalledWith(
      { x: 540, y: 0, width: 360, height: 56 },
      false,
    );
    controller.destroy();
  });

  it('validates against current bounds, drops stale regions after resize, and ignores hidden input', async () => {
    const overlayWindow = createOverlayWindowMock({ x: 1352, y: 412, width: 88, height: 100 });
    mockOverlayWindow(overlayWindow);
    const { createOverlayController, isValidOverlayHitRegion, overlayBounds } =
      await import('../../src/main/overlay-controller');
    const controller = createOverlayController();

    expect(overlayBounds({ x: 0, y: 0, width: 40, height: 40 })).toEqual({
      x: 0,
      y: 0,
      width: 40,
      height: 40,
    });
    // Hangs from the top edge, centered horizontally (odd widths round), over the menu bar.
    expect(overlayBounds({ x: 0, y: 0, width: 1440, height: 900 })).toEqual({
      x: 540,
      y: 0,
      width: 360,
      height: 56,
    });
    expect(overlayBounds({ x: -1200, y: -1080, width: 1921, height: 1080 })).toEqual({
      x: -419,
      y: -1080,
      width: 360,
      height: 56,
    });
    expect(isValidOverlayHitRegion({ x: 10, y: 90, width: 24, height: 10 }, 88, 100)).toBe(true);
    expect(isValidOverlayHitRegion({ x: 10, y: 90, width: 24, height: 11 }, 88, 100)).toBe(false);

    controller.setRendererReady();
    overlayWindow.readyListener?.();
    controller.setQualifyingSessionCount(1);
    expect(controller.setHitRegions([{ x: 10, y: 90, width: 24, height: 10 }])).toBe(true);
    expect(controller.setHitRegions([{ x: 10, y: 90, width: 24, height: 11 }])).toBe(false);
    expect(controller.setHitRegions([{ x: 10, y: 90, width: 24, height: 10 }])).toBe(true);
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });

    electronMocks.screen.getPrimaryDisplay.mockReturnValue({
      bounds: { x: 0, y: 0, width: 1440, height: 50 },
      workArea: { x: 0, y: 24, width: 1440, height: 26 },
    });
    const reposition = electronMocks.screen.on.mock.calls.find(
      ([event]) => event === 'display-metrics-changed',
    )?.[1] as (() => void) | undefined;
    reposition?.();
    expect(overlayWindow.setBounds).toHaveBeenLastCalledWith(
      { x: 540, y: 0, width: 360, height: 50 },
      false,
    );
    expect(controller.setHitRegions([{ x: 10, y: 41, width: 24, height: 10 }])).toBe(false);

    electronMocks.screen.getCursorScreenPoint.mockReturnValue({ x: 552, y: 36 });
    expect(controller.setHitRegions([{ x: 10, y: 20, width: 24, height: 24 }])).toBe(true);
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, undefined);
    controller.setQualifyingSessionCount(0);
    overlayWindow.pointerListener?.({ type: 'mouseMove', x: 10, y: 90 });
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    controller.destroy();
    expect(controller.setHitRegions([{ x: 10, y: 20, width: 24, height: 24 }])).toBe(false);
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
    expect(isValidOverlayHitRegion({ x: 360, y: 20, width: 10, height: 24 })).toBe(false);
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
    controller.setRendererReady();
    overlayWindow.readyListener?.();
    controller.setQualifyingSessionCount(1);
    electronMocks.screen.getCursorScreenPoint.mockReturnValue({ x: 1092, y: 98 });
    expect(controller.setHitRegions([{ x: 10, y: 20, width: 24, height: 24 }])).toBe(true);
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, undefined);
    expect(controller.setHitRegions([{ x: 40, y: 20, width: 24, height: 24 }])).toBe(true);
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(controller.setHitRegions([{ x: 10, y: 20, width: 24, height: 24 }])).toBe(true);

    overlayWindow.pointerListener?.({ type: 'mouseMove', x: 12, y: 22 });
    overlayWindow.pointerListener?.({ type: 'mouseMove', x: 34, y: 22 });
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    overlayWindow.pointerListener?.({ type: 'mouseMove', x: 12, y: 22 });
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, undefined);
    overlayWindow.pointerListener?.({ type: 'mouseLeave', x: 34, y: 22 });
    expect(overlayWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    controller.destroy();
  });

  it('ignores stale callbacks from a closed generation after one replacement', async () => {
    const firstWindow = createOverlayWindowMock();
    const secondWindow = createOverlayWindowMock();
    electronMocks.BrowserWindow.mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return firstWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    ).mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return secondWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    );
    const { createOverlayController } = await import('../../src/main/overlay-controller');
    const controller = createOverlayController();
    controller.setQualifyingSessionCount(1);
    firstWindow.readyListener?.();
    firstWindow.closedListener?.();
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);

    firstWindow.loadingListener?.();
    firstWindow.pointerListener?.({ type: 'mouseMove', x: 20, y: 20 });
    firstWindow.closedListener?.();
    firstWindow.readyListener?.();
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
    expect(secondWindow.showInactive).not.toHaveBeenCalled();

    secondWindow.readyListener?.();
    expect(secondWindow.showInactive).not.toHaveBeenCalled();
    controller.setRendererReady();
    expect(secondWindow.showInactive).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('replaces a crashed renderer and ignores its stale callbacks', async () => {
    const firstWindow = createOverlayWindowMock();
    const secondWindow = createOverlayWindowMock();
    electronMocks.BrowserWindow.mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return firstWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    ).mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return secondWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    );
    const { createOverlayController } = await import('../../src/main/overlay-controller');
    const controller = createOverlayController();
    controller.setQualifyingSessionCount(1);
    controller.setRendererReady();
    firstWindow.readyListener?.();
    expect(controller.setHitRegions([{ x: 10, y: 20, width: 24, height: 24 }])).toBe(true);

    firstWindow.rendererGoneListener?.();

    expect(firstWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(firstWindow.destroy).toHaveBeenCalledOnce();
    expect(controller.getWindow()).toBe(secondWindow);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
    firstWindow.rendererGoneListener?.();
    firstWindow.closedListener?.();
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
    secondWindow.readyListener?.();
    expect(secondWindow.showInactive).not.toHaveBeenCalled();
    controller.setRendererReady();
    expect(secondWindow.showInactive).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('replaces a live window after a failed main-frame reload', async () => {
    const firstWindow = createOverlayWindowMock();
    const secondWindow = createOverlayWindowMock();
    electronMocks.BrowserWindow.mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return firstWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    ).mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return secondWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    );
    const { createOverlayController } = await import('../../src/main/overlay-controller');
    const controller = createOverlayController({ onKeyboardEntry: () => true });
    controller.setQualifyingSessionCount(1);
    controller.setRendererReady();
    firstWindow.readyListener?.();
    controller.enterKeyboardMode();

    firstWindow.loadingListener?.();
    firstWindow.failedLoadListener?.();

    expect(firstWindow.destroy).toHaveBeenCalledOnce();
    expect(controller.getWindow()).toBe(secondWindow);
    expect(electronMocks.app.hide).toHaveBeenCalledOnce();
    expect(electronMocks.app.show).toHaveBeenCalledOnce();
    secondWindow.readyListener?.();
    expect(secondWindow.showInactive).not.toHaveBeenCalled();
    controller.setRendererReady();
    expect(secondWindow.showInactive).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('does not recover a hidden or empty overlay until both visibility and sessions return', async () => {
    const firstWindow = createOverlayWindowMock();
    const secondWindow = createOverlayWindowMock();
    electronMocks.BrowserWindow.mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return firstWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    ).mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return secondWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    );
    const { createOverlayController } = await import('../../src/main/overlay-controller');
    const controller = createOverlayController();

    controller.setVisible(false);
    firstWindow.closedListener?.();
    controller.recover();
    expect(electronMocks.BrowserWindow).toHaveBeenCalledOnce();

    controller.setVisible(true);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledOnce();
    controller.setQualifyingSessionCount(1);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  it('recreates a destroyed window from display, resume, or explicit recovery exactly once', async () => {
    const firstWindow = createOverlayWindowMock();
    const secondWindow = createOverlayWindowMock();
    electronMocks.BrowserWindow.mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return firstWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    ).mockImplementationOnce(
      class BrowserWindowMock {
        constructor() {
          return secondWindow;
        }
      } as unknown as typeof electronMocks.BrowserWindow,
    );
    const { createOverlayController } = await import('../../src/main/overlay-controller');
    const controller = createOverlayController();
    controller.setQualifyingSessionCount(1);
    firstWindow.markDestroyed();

    const onDisplayAdded = electronMocks.screen.on.mock.calls.find(
      ([event]) => event === 'display-added',
    )?.[1] as (() => void) | undefined;
    const onResume = electronMocks.powerMonitor.on.mock.calls.find(
      ([event]) => event === 'resume',
    )?.[1] as (() => void) | undefined;
    onDisplayAdded?.();
    onResume?.();
    controller.recover();

    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
    expect(controller.getWindow()).toBe(secondWindow);
    controller.destroy();
  });

  it('clears hit regions and remains inert across repeated destruction', async () => {
    const overlayWindow = createOverlayWindowMock();
    mockOverlayWindow(overlayWindow);
    const { createOverlayController } = await import('../../src/main/overlay-controller');
    const controller = createOverlayController();
    controller.setRendererReady();
    overlayWindow.readyListener?.();
    controller.setQualifyingSessionCount(1);
    expect(controller.setHitRegions([{ x: 10, y: 20, width: 24, height: 24 }])).toBe(true);

    controller.destroy();
    controller.destroy();
    overlayWindow.closedListener?.();
    overlayWindow.loadingListener?.();
    controller.recover();
    controller.setRendererReady();
    controller.setVisible(true);
    controller.setQualifyingSessionCount(1);

    expect(controller.setHitRegions([{ x: 10, y: 20, width: 24, height: 24 }])).toBe(false);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledOnce();
    expect(electronMocks.screen.off).toHaveBeenCalledWith(
      'display-metrics-changed',
      expect.any(Function),
    );
    expect(electronMocks.powerMonitor.off).toHaveBeenCalledWith('resume', expect.any(Function));
  });
});

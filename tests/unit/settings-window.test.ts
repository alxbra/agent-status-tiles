import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SettingsWindowMock = {
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
  };
};

const electronMocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  BrowserWindow: vi.fn(),
}));

vi.mock('electron', () => electronMocks);

function createWindowMock(alreadyDestroyed: boolean): SettingsWindowMock {
  return {
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => alreadyDestroyed),
    isMinimized: vi.fn(() => false),
    loadFile: vi.fn(() => Promise.reject(new Error('renderer failed to load'))),
    loadURL: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    webContents: {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };
}

function mockBrowserWindows(...windows: SettingsWindowMock[]): void {
  const remainingWindows = [...windows];
  const BrowserWindowMock = class {
    constructor() {
      return remainingWindows.shift() ?? createWindowMock(false);
    }
  };
  electronMocks.BrowserWindow.mockImplementation(
    BrowserWindowMock as unknown as typeof electronMocks.BrowserWindow,
  );
}

describe('Settings window load recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMocks.BrowserWindow.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('destroys a live failed window and retries with a fresh instance', async () => {
    const firstWindow = createWindowMock(false);
    const secondWindow = createWindowMock(false);
    mockBrowserWindows(firstWindow, secondWindow);
    const { showSettingsWindow } = await import('../../src/main/settings-window');

    expect(showSettingsWindow()).toBe(firstWindow);
    await vi.waitFor(() => expect(firstWindow.destroy).toHaveBeenCalledOnce());

    expect(showSettingsWindow()).toBe(secondWindow);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
  });

  it('does not destroy an already-destroyed failed window before retrying', async () => {
    const firstWindow = createWindowMock(true);
    const secondWindow = createWindowMock(false);
    mockBrowserWindows(firstWindow, secondWindow);
    const { showSettingsWindow } = await import('../../src/main/settings-window');

    expect(showSettingsWindow()).toBe(firstWindow);
    await vi.waitFor(() => expect(firstWindow.isDestroyed).toHaveBeenCalled());
    expect(firstWindow.destroy).not.toHaveBeenCalled();

    expect(showSettingsWindow()).toBe(secondWindow);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
  });

  it('refreshes native settings whenever an existing window regains focus', async () => {
    const window = createWindowMock(false);
    window.loadFile.mockReturnValue(new Promise(() => undefined));
    mockBrowserWindows(window);
    const onFocus = vi.fn();
    const { showSettingsWindow } = await import('../../src/main/settings-window');

    showSettingsWindow(onFocus);
    const focusRegistration = window.on.mock.calls.find(([event]) => event === 'focus');
    const focusListener = focusRegistration?.[1] as (() => void) | undefined;
    expect(focusListener).toBeTypeOf('function');

    focusListener?.();

    expect(onFocus).toHaveBeenCalledOnce();
    showSettingsWindow(onFocus);
    expect(window.focus).toHaveBeenCalledOnce();
  });
});

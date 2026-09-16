import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
  };
});

vi.mock('electron', () => electronMocks);

import { IPC_CHANNELS, type SettingsState } from '../../src/shared/ipc';

function settingsState(): SettingsState {
  return {
    providers: {
      codexDesktop: { status: 'disconnected', canConnect: true, canDisconnect: false },
      codexCli: { status: 'unavailable', canConnect: false, canDisconnect: false },
      claudeCode: { status: 'unavailable', canConnect: false, canDisconnect: false },
    },
    displays: [
      { id: 'primary', label: 'Primary' },
      { id: '42', label: 'Display 2' },
    ],
    selectedDisplayId: 'primary',
    launchAtLogin: false,
    reduceMotion: false,
  };
}

function settingsWindow(): {
  isDestroyed: ReturnType<typeof vi.fn>;
  webContents: { mainFrame: object; send: ReturnType<typeof vi.fn> };
} {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { mainFrame: {}, send: vi.fn() },
  };
}

describe('settings IPC', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMocks.handlers.clear();
    electronMocks.ipcMain.handle.mockClear();
    electronMocks.ipcMain.removeHandler.mockClear();
  });

  it('validates sender frames and exact payloads for every settings command', async () => {
    const { registerSettingsIpcHandlers } = await import('../../src/main/settings-ipc');
    const window = settingsWindow();
    const options = {
      getWindow: () => window as never,
      getState: settingsState,
      setDisplayPreference: vi.fn((displayId: string) => {
        if (displayId === '99') throw new Error('Selected display is not connected');
        return settingsState();
      }),
      setReduceMotion: vi.fn(() => settingsState()),
      setLaunchAtLogin: vi.fn(() => settingsState()),
      connectSurface: vi.fn(() => settingsState()),
      disconnectSurface: vi.fn(() => settingsState()),
    };
    const cleanup = registerSettingsIpcHandlers(options);
    const mainFrame = window.webContents.mainFrame;
    const validEvent = { sender: window.webContents, senderFrame: mainFrame };

    for (const channel of [
      IPC_CHANNELS.settingsGet,
      IPC_CHANNELS.settingsDisplayChange,
      IPC_CHANNELS.settingsReduceMotionChange,
      IPC_CHANNELS.settingsLaunchAtLoginChange,
      IPC_CHANNELS.settingsSurfaceConnect,
      IPC_CHANNELS.settingsSurfaceDisconnect,
    ]) {
      const handler = electronMocks.handlers.get(channel)!;
      await expect(
        Promise.resolve().then(() => handler({ sender: {}, senderFrame: mainFrame })),
      ).rejects.toThrow('Settings IPC sender is not recognized');
      await expect(
        Promise.resolve().then(() =>
          handler({ sender: window.webContents, senderFrame: {} }, undefined),
        ),
      ).rejects.toThrow('Settings IPC sender is not recognized');
    }

    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(IPC_CHANNELS.settingsGet)!(validEvent, {}),
      ),
    ).rejects.toThrow('Settings request does not accept a payload');
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(IPC_CHANNELS.settingsDisplayChange)!(validEvent, {
          displayId: '42',
          extra: true,
        }),
      ),
    ).rejects.toThrow('Display preference request is invalid');
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(IPC_CHANNELS.settingsDisplayChange)!(validEvent, {
          displayId: '99',
        }),
      ),
    ).rejects.toThrow('Selected display is not connected');
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(IPC_CHANNELS.settingsReduceMotionChange)!(validEvent, {
          enabled: true,
          extra: false,
        }),
      ),
    ).rejects.toThrow('Reduce motion preference request is invalid');
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(IPC_CHANNELS.settingsSurfaceConnect)!(validEvent, {
          connection: 'codexDesktop',
          path: '/private',
        }),
      ),
    ).rejects.toThrow('Connection request is invalid');
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(IPC_CHANNELS.settingsSurfaceDisconnect)!(validEvent, {
          connection: 'codexDesktop',
          confirmed: false,
        }),
      ),
    ).rejects.toThrow('Disconnect request is invalid');
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(IPC_CHANNELS.settingsSurfaceConnect)!(validEvent, {
          connection: 'codexDesktop',
        }),
      ),
    ).resolves.toEqual(settingsState());
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(IPC_CHANNELS.settingsSurfaceDisconnect)!(validEvent, {
          connection: 'codexDesktop',
          confirmed: true,
        }),
      ),
    ).resolves.toEqual(settingsState());
    expect(options.connectSurface).toHaveBeenCalledWith('codexDesktop');
    expect(options.disconnectSurface).toHaveBeenCalledWith('codexDesktop');

    cleanup();
    cleanup();
    expect(electronMocks.ipcMain.removeHandler).toHaveBeenCalledTimes(6);
  });

  it('publishes only validated state to the current Settings window', async () => {
    const { publishSettingsState } = await import('../../src/main/settings-ipc');
    const window = settingsWindow();
    const state = settingsState();
    expect(publishSettingsState(window as never, state)).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.settingsChanged, state);
    expect(publishSettingsState(null, state)).toBe(false);
    expect(publishSettingsState(window as never, { ...state, path: '/private' } as never)).toBe(
      false,
    );
    expect(publishSettingsState(window as never, { ...state, selectedDisplayId: '99' })).toBe(
      false,
    );
    expect(
      publishSettingsState(window as never, {
        ...state,
        displays: Array.from({ length: 33 }, (_, index) => ({
          id: String(index + 1),
          label: `Display ${String(index + 1)}`,
        })),
        selectedDisplayId: '1',
      }),
    ).toBe(false);
  });
});

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  IPC_CHANNELS,
  isDisplayPreferenceChangeRequest,
  isLaunchAtLoginChangeRequest,
  isReduceMotionPreferenceChangeRequest,
  isRecentThreadLimitChangeRequest,
  isSettingsState,
  isSettingsConnectionRequest,
  isSettingsDisconnectRequest,
  type SettingsConnectionKey,
  type SettingsState,
} from '../shared/ipc';

export interface SettingsIpcOptions {
  getWindow: () => BrowserWindow | null;
  getState: () => SettingsState;
  setDisplayPreference: (displayId: string) => SettingsState | Promise<SettingsState>;
  setReduceMotion: (enabled: boolean) => SettingsState | Promise<SettingsState>;
  setRecentThreadLimit: (limit: number) => SettingsState | Promise<SettingsState>;
  setLaunchAtLogin: (enabled: boolean) => SettingsState | Promise<SettingsState>;
  connectSurface: (connection: SettingsConnectionKey) => SettingsState | Promise<SettingsState>;
  disconnectSurface: (connection: SettingsConnectionKey) => SettingsState | Promise<SettingsState>;
}

function assertSettingsSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
): void {
  const settingsWindow = getWindow();
  if (
    !settingsWindow ||
    settingsWindow.isDestroyed() ||
    event.sender !== settingsWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Settings IPC sender is not recognized');
  }
}

function assertNoPayload(payload: unknown, message: string): void {
  if (payload !== undefined) throw new Error(message);
}

function assertState(state: SettingsState): SettingsState {
  if (!isSettingsState(state)) throw new Error('Settings state is invalid');
  return state;
}

/** Register settings read/write handlers and return an exact cleanup operation. */
export function registerSettingsIpcHandlers(options: SettingsIpcOptions): () => void {
  const assertSender = (event: IpcMainInvokeEvent): void =>
    assertSettingsSender(event, options.getWindow);

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event, payload?: unknown) => {
    assertSender(event);
    assertNoPayload(payload, 'Settings request does not accept a payload');
    return assertState(options.getState());
  });

  ipcMain.handle(IPC_CHANNELS.settingsDisplayChange, async (event, payload: unknown) => {
    assertSender(event);
    if (!isDisplayPreferenceChangeRequest(payload)) {
      throw new Error('Display preference request is invalid');
    }
    return assertState(await options.setDisplayPreference(payload.displayId));
  });

  ipcMain.handle(IPC_CHANNELS.settingsReduceMotionChange, async (event, payload: unknown) => {
    assertSender(event);
    if (!isReduceMotionPreferenceChangeRequest(payload)) {
      throw new Error('Reduce motion preference request is invalid');
    }
    return assertState(await options.setReduceMotion(payload.enabled));
  });

  ipcMain.handle(IPC_CHANNELS.settingsRecentThreadLimitChange, async (event, payload: unknown) => {
    assertSender(event);
    if (!isRecentThreadLimitChangeRequest(payload))
      throw new Error('Recent thread limit request is invalid');
    return assertState(await options.setRecentThreadLimit(payload.limit));
  });

  ipcMain.handle(IPC_CHANNELS.settingsLaunchAtLoginChange, async (event, payload: unknown) => {
    assertSender(event);
    if (!isLaunchAtLoginChangeRequest(payload)) {
      throw new Error('Launch-at-login request is invalid');
    }
    return assertState(await options.setLaunchAtLogin(payload.enabled));
  });

  ipcMain.handle(IPC_CHANNELS.settingsSurfaceConnect, async (event, payload: unknown) => {
    assertSender(event);
    if (!isSettingsConnectionRequest(payload)) {
      throw new Error('Connection request is invalid');
    }
    return assertState(await options.connectSurface(payload.connection));
  });

  ipcMain.handle(IPC_CHANNELS.settingsSurfaceDisconnect, async (event, payload: unknown) => {
    assertSender(event);
    if (!isSettingsDisconnectRequest(payload)) {
      throw new Error('Disconnect request is invalid');
    }
    return assertState(await options.disconnectSurface(payload.connection));
  });

  let isRegistered = true;
  return () => {
    if (!isRegistered) return;
    isRegistered = false;
    for (const channel of [
      IPC_CHANNELS.settingsGet,
      IPC_CHANNELS.settingsDisplayChange,
      IPC_CHANNELS.settingsReduceMotionChange,
      IPC_CHANNELS.settingsRecentThreadLimitChange,
      IPC_CHANNELS.settingsLaunchAtLoginChange,
      IPC_CHANNELS.settingsSurfaceConnect,
      IPC_CHANNELS.settingsSurfaceDisconnect,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}

/** Publish a validated state projection only to the current Settings window. */
export function publishSettingsState(
  settingsWindow: BrowserWindow | null,
  state: SettingsState,
): boolean {
  if (settingsWindow === null || settingsWindow.isDestroyed() || !isSettingsState(state)) {
    return false;
  }
  settingsWindow.webContents.send(IPC_CHANNELS.settingsChanged, state);
  return true;
}

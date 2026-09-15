import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  isDisplayPreferenceChangeRequest,
  isLaunchAtLoginChangeRequest,
  isReduceMotionPreferenceChangeRequest,
  isSettingsState,
  type AgentStatusTilesApi,
  type SettingsState,
} from '../shared/ipc';

function invokeSettingsState(channel: string, payload?: unknown): Promise<SettingsState> {
  return ipcRenderer.invoke(channel, payload).then(readSettingsState);
}

function readSettingsState(value: unknown): SettingsState {
  if (!isSettingsState(value)) throw new Error('Settings state is invalid');
  return value;
}

const api: AgentStatusTilesApi = {
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.version),
  openSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsOpen),
  closeSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsClose),
  getSettings: () => invokeSettingsState(IPC_CHANNELS.settingsGet),
  subscribeSettings: (listener) => {
    const handleSettingsChanged = (_event: Electron.IpcRendererEvent, state: unknown): void => {
      if (isSettingsState(state)) listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.settingsChanged, handleSettingsChanged);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.settingsChanged, handleSettingsChanged);
  },
  setDisplayPreference: (displayId) => {
    const request = { displayId };
    if (!isDisplayPreferenceChangeRequest(request)) {
      return Promise.reject(new Error('Display preference request is invalid'));
    }
    return invokeSettingsState(IPC_CHANNELS.settingsDisplayChange, request);
  },
  setReduceMotion: (enabled) => {
    const request = { enabled };
    if (!isReduceMotionPreferenceChangeRequest(request)) {
      return Promise.reject(new Error('Reduce motion preference request is invalid'));
    }
    return invokeSettingsState(IPC_CHANNELS.settingsReduceMotionChange, request);
  },
  setLaunchAtLogin: (enabled) => {
    const request = { enabled };
    if (!isLaunchAtLoginChangeRequest(request)) {
      return Promise.reject(new Error('Launch-at-login request is invalid'));
    }
    return invokeSettingsState(IPC_CHANNELS.settingsLaunchAtLoginChange, request);
  },
};

contextBridge.exposeInMainWorld('agentStatusTiles', api);

import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, type AgentStatusTilesApi } from '../shared/ipc';

const api: AgentStatusTilesApi = {
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.version),
  openSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsOpen),
  closeSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsClose),
};

contextBridge.exposeInMainWorld('agentStatusTiles', api);

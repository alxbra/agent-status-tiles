import { contextBridge, ipcRenderer } from 'electron';

import {
  isOverlayDismissErrorRequest,
  isOverlayHitRegions,
  isOverlayOpenSessionRequest,
  isOverlayActionResult,
  isOverlayState,
  OVERLAY_ACTION_UNAVAILABLE,
  OVERLAY_IPC_CHANNELS,
  type AgentStatusTilesOverlayApi,
  type OverlayDismissErrorRequest,
  type OverlayHitRegion,
  type OverlayOpenSessionRequest,
  type OverlayState,
} from '../shared/overlay-ipc';

const api: AgentStatusTilesOverlayApi = {
  getState: () =>
    ipcRenderer.invoke(OVERLAY_IPC_CHANNELS.getState).then((state: unknown) => {
      if (!isOverlayState(state)) throw new Error('Overlay state is invalid');
      return state;
    }),
  subscribe: (listener: (state: OverlayState) => void): (() => void) => {
    const handleStateChanged = (_event: Electron.IpcRendererEvent, state: unknown): void => {
      if (isOverlayState(state)) listener(state);
    };
    ipcRenderer.on(OVERLAY_IPC_CHANNELS.stateChanged, handleStateChanged);
    return () => ipcRenderer.removeListener(OVERLAY_IPC_CHANNELS.stateChanged, handleStateChanged);
  },
  publishHitRegions: (regions: readonly OverlayHitRegion[]): Promise<boolean> => {
    if (!isOverlayHitRegions(regions)) return Promise.resolve(false);
    return ipcRenderer
      .invoke(OVERLAY_IPC_CHANNELS.publishHitRegions, regions)
      .then((accepted: unknown) => {
        if (typeof accepted !== 'boolean') throw new Error('Overlay hit-region result is invalid');
        return accepted;
      });
  },
  openSession: (request: OverlayOpenSessionRequest) => {
    if (!isOverlayOpenSessionRequest(request)) return Promise.resolve(OVERLAY_ACTION_UNAVAILABLE);
    return ipcRenderer.invoke(OVERLAY_IPC_CHANNELS.openSession, request).then((result: unknown) => {
      if (!isOverlayActionResult(result)) throw new Error('Overlay action result is invalid');
      return result;
    });
  },
  dismissError: (request: OverlayDismissErrorRequest) => {
    if (!isOverlayDismissErrorRequest(request)) return Promise.resolve(OVERLAY_ACTION_UNAVAILABLE);
    return ipcRenderer
      .invoke(OVERLAY_IPC_CHANNELS.dismissError, request)
      .then((result: unknown) => {
        if (!isOverlayActionResult(result)) throw new Error('Overlay action result is invalid');
        return result;
      });
  },
};

contextBridge.exposeInMainWorld('agentStatusTilesOverlay', api);

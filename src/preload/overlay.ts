import { contextBridge, ipcRenderer } from 'electron';

import {
  isOverlayDismissErrorRequest,
  isOverlayHitRegions,
  isOverlayNoPayload,
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
  subscribeKeyboardEntry: (listener: () => void): (() => void) => {
    const handleKeyboardEntry = (_event: Electron.IpcRendererEvent, payload?: unknown): void => {
      if (isOverlayNoPayload(payload)) listener();
    };
    ipcRenderer.on(OVERLAY_IPC_CHANNELS.keyboardEntry, handleKeyboardEntry);
    return () =>
      ipcRenderer.removeListener(OVERLAY_IPC_CHANNELS.keyboardEntry, handleKeyboardEntry);
  },
  requestKeyboardExit: (): Promise<void> =>
    ipcRenderer.invoke(OVERLAY_IPC_CHANNELS.keyboardExit).then((result: unknown) => {
      if (!isOverlayNoPayload(result)) throw new Error('Overlay keyboard-exit result is invalid');
    }),
  rendererReady: (): Promise<void> =>
    ipcRenderer.invoke(OVERLAY_IPC_CHANNELS.rendererReady).then((result: unknown) => {
      if (!isOverlayNoPayload(result)) throw new Error('Overlay renderer-ready result is invalid');
    }),
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

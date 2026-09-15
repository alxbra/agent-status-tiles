import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  isOverlayDismissErrorRequest,
  isOverlayHitRegions,
  isOverlayOpenSessionRequest,
  isOverlayState,
  OVERLAY_ACTION_UNAVAILABLE,
  OVERLAY_IPC_CHANNELS,
  type OverlayActionResult,
  type OverlayHitRegion,
  type OverlayState,
} from '../shared/overlay-ipc';

export interface OverlayIpcOptions {
  getWindow: () => BrowserWindow | null;
  getState: () => OverlayState;
  setHitRegions: (regions: readonly OverlayHitRegion[]) => boolean;
}

function assertOverlaySender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
): void {
  const overlayWindow = getWindow();
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    event.sender !== overlayWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Overlay IPC sender is not recognized');
  }
}

function assertNoPayload(payload: unknown): void {
  if (payload !== undefined) throw new Error('Overlay state request does not accept a payload');
}

/** Register the complete overlay surface and return its exact cleanup operation. */
export function registerOverlayIpcHandlers(options: OverlayIpcOptions): () => void {
  const assertSender = (event: IpcMainInvokeEvent): void =>
    assertOverlaySender(event, options.getWindow);

  ipcMain.handle(OVERLAY_IPC_CHANNELS.getState, (event, payload?: unknown) => {
    assertSender(event);
    assertNoPayload(payload);
    const state = options.getState();
    if (!isOverlayState(state)) throw new Error('Overlay state is invalid');
    return state;
  });

  ipcMain.handle(OVERLAY_IPC_CHANNELS.publishHitRegions, (event, payload: unknown) => {
    assertSender(event);
    if (!isOverlayHitRegions(payload)) throw new Error('Overlay hit regions are invalid');
    return options.setHitRegions(payload);
  });

  ipcMain.handle(
    OVERLAY_IPC_CHANNELS.openSession,
    (event, payload: unknown): OverlayActionResult => {
      assertSender(event);
      if (!isOverlayOpenSessionRequest(payload)) {
        throw new Error('Overlay open-session request is invalid');
      }
      // Navigation is deliberately outside this bounded bridge slice.
      return OVERLAY_ACTION_UNAVAILABLE;
    },
  );

  ipcMain.handle(
    OVERLAY_IPC_CHANNELS.dismissError,
    (event, payload: unknown): OverlayActionResult => {
      assertSender(event);
      if (!isOverlayDismissErrorRequest(payload)) {
        throw new Error('Overlay dismiss-error request is invalid');
      }
      // Dismissal is deliberately outside this bounded bridge slice.
      return OVERLAY_ACTION_UNAVAILABLE;
    },
  );

  let isRegistered = true;
  return () => {
    if (!isRegistered) return;
    isRegistered = false;
    for (const channel of Object.values(OVERLAY_IPC_CHANNELS)) {
      if (channel === OVERLAY_IPC_CHANNELS.stateChanged) continue;
      ipcMain.removeHandler(channel);
    }
  };
}

/** Publish only the allowlisted state projection to the exact overlay window. */
export function publishOverlayState(
  overlayWindow: BrowserWindow | null,
  state: OverlayState,
): boolean {
  if (overlayWindow === null || overlayWindow.isDestroyed() || !isOverlayState(state)) {
    return false;
  }

  overlayWindow.webContents.send(OVERLAY_IPC_CHANNELS.stateChanged, state);
  return true;
}

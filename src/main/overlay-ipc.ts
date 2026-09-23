import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  isOverlayDismissErrorRequest,
  isOverlayHitRegions,
  isOverlayNoPayload,
  isOverlayOpenSessionRequest,
  isOverlayState,
  OVERLAY_ACTION_UNAVAILABLE,
  OVERLAY_IPC_CHANNELS,
  type OverlayActionResult,
  type OverlayHitRegion,
  type OverlayOpenSessionRequest,
  type OverlayState,
} from '../shared/overlay-ipc';

export interface OverlayIpcOptions {
  getWindow: () => BrowserWindow | null;
  getState: () => OverlayState;
  setHitRegions: (regions: readonly OverlayHitRegion[]) => boolean;
  onKeyboardExit?: () => void;
  onRendererReady?: () => void;
  /** Opens a thread the island shows; without it, clicks report unavailable. */
  openSession?: (request: OverlayOpenSessionRequest) => Promise<OverlayActionResult>;
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

function assertNoPayload(payload: unknown, label = 'Overlay state request'): void {
  if (!isOverlayNoPayload(payload)) throw new Error(`${label} does not accept a payload`);
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

  ipcMain.handle(OVERLAY_IPC_CHANNELS.keyboardExit, (event, payload?: unknown): void => {
    assertSender(event);
    assertNoPayload(payload, 'Overlay keyboard-exit request');
    options.onKeyboardExit?.();
  });

  ipcMain.handle(OVERLAY_IPC_CHANNELS.rendererReady, (event, payload?: unknown): void => {
    assertSender(event);
    assertNoPayload(payload, 'Overlay renderer-ready request');
    options.onRendererReady?.();
  });

  ipcMain.handle(OVERLAY_IPC_CHANNELS.publishHitRegions, (event, payload: unknown) => {
    assertSender(event);
    if (!isOverlayHitRegions(payload)) throw new Error('Overlay hit regions are invalid');
    return options.setHitRegions(payload);
  });

  ipcMain.handle(
    OVERLAY_IPC_CHANNELS.openSession,
    async (event, payload: unknown): Promise<OverlayActionResult> => {
      assertSender(event);
      if (!isOverlayOpenSessionRequest(payload)) {
        throw new Error('Overlay open-session request is invalid');
      }
      return options.openSession?.(payload) ?? OVERLAY_ACTION_UNAVAILABLE;
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
      if (
        channel === OVERLAY_IPC_CHANNELS.stateChanged ||
        channel === OVERLAY_IPC_CHANNELS.keyboardEntry
      ) {
        continue;
      }
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

/** Notify only the exact overlay window that deliberate keyboard entry occurred. */
export function publishOverlayKeyboardEntry(overlayWindow: BrowserWindow | null): boolean {
  if (overlayWindow === null || overlayWindow.isDestroyed()) return false;

  overlayWindow.webContents.send(OVERLAY_IPC_CHANNELS.keyboardEntry);
  return true;
}

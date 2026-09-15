import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { closeSettingsWindow, getSettingsWindow, showSettingsWindow } from './settings-window';
import { createMenuBar, type MenuBarController } from './menu-bar';
import { createOverlayController, type OverlayController } from './overlay-controller';
import { registerOverlayIpcHandlers } from './overlay-ipc';
import { createStartupOverlayState } from './test-session-source';
import packageJson from '../../package.json';
import { IPC_CHANNELS } from '../shared/ipc';
import type { OverlayState } from '../shared/overlay-ipc';
import type { SessionSnapshot } from '../shared/session';

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let menuBar: MenuBarController | null = null;
let overlayController: OverlayController | null = null;
let removeOverlayIpcHandlers: (() => void) | null = null;
const overlayState: OverlayState = createStartupOverlayState(app.isPackaged);

function isQualifyingSession(session: SessionSnapshot): boolean {
  return session.isTopLevel && !session.isArchived && session.status !== 'idle';
}

function qualifyingSessionCount(sessions: readonly SessionSnapshot[]): number {
  return sessions.filter(isQualifyingSession).length;
}

function assertSettingsSender(event: IpcMainInvokeEvent): void {
  const settingsWindow = getSettingsWindow();
  if (
    !settingsWindow ||
    event.sender !== settingsWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Settings IPC sender is not recognized');
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.version, (event) => {
    assertSettingsSender(event);
    return app.isPackaged ? app.getVersion() : packageJson.version;
  });
  ipcMain.handle(IPC_CHANNELS.settingsOpen, (event) => {
    assertSettingsSender(event);
    showSettingsWindow();
  });
  ipcMain.handle(IPC_CHANNELS.settingsClose, (event) => {
    assertSettingsSender(event);
    closeSettingsWindow();
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showSettingsWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    removeOverlayIpcHandlers?.();
    removeOverlayIpcHandlers = null;
    menuBar?.destroy();
    overlayController?.destroy();
    menuBar = null;
    overlayController = null;
  });

  void app.whenReady().then(() => {
    if (process.platform === 'darwin') {
      app.dock?.hide();
    }

    overlayController = createOverlayController();
    overlayController.setQualifyingSessionCount(qualifyingSessionCount(overlayState.sessions));
    removeOverlayIpcHandlers = registerOverlayIpcHandlers({
      getWindow: () => overlayController?.getWindow() ?? null,
      getState: () => overlayState,
      setHitRegions: (regions) => overlayController?.setHitRegions(regions) ?? false,
    });
    menuBar = createMenuBar({
      showOverlay: () => overlayController?.setVisible(true),
      hideOverlay: () => overlayController?.setVisible(false),
      openSettings: showSettingsWindow,
      quit: () => app.quit(),
    });
    registerIpcHandlers();
    showSettingsWindow();
    app.on('activate', () => {
      showSettingsWindow();
    });
  });
}

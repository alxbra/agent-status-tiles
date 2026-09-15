import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { closeSettingsWindow, getSettingsWindow, showSettingsWindow } from './settings-window';
import packageJson from '../../package.json';
import { IPC_CHANNELS } from '../shared/ipc';

const hasSingleInstanceLock = app.requestSingleInstanceLock();

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

  void app.whenReady().then(() => {
    registerIpcHandlers();
    showSettingsWindow();
    app.on('activate', () => {
      showSettingsWindow();
    });
  });
}

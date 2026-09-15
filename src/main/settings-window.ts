import { BrowserWindow, app } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { protectWebContents } from './security';

let settingsWindow: BrowserWindow | null = null;

function rendererFilePath(): string {
  return join(__dirname, '../renderer/index.html');
}

function rendererUrl(): string {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }

  return pathToFileURL(rendererFilePath()).href;
}

export function getSettingsWindow(): BrowserWindow | null {
  if (settingsWindow?.isDestroyed()) {
    settingsWindow = null;
  }

  return settingsWindow;
}

export function showSettingsWindow(): BrowserWindow {
  const existingWindow = getSettingsWindow();
  if (existingWindow) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
    return existingWindow;
  }

  const allowedUrl = rendererUrl();
  const window = new BrowserWindow({
    title: 'Settings',
    width: 420,
    height: 320,
    minWidth: 320,
    minHeight: 240,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      preload: join(__dirname, '../preload/index.js'),
    },
  });

  settingsWindow = window;
  protectWebContents(window, allowedUrl);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (settingsWindow === window) {
      settingsWindow = null;
    }
  });

  const loadPromise =
    allowedUrl.startsWith('http://') || allowedUrl.startsWith('https://')
      ? window.loadURL(allowedUrl)
      : window.loadFile(rendererFilePath());
  void loadPromise.catch((error: unknown) => {
    console.error('Unable to load Settings window', error);
    if (settingsWindow === window) {
      settingsWindow = null;
    }
    if (!window.isDestroyed()) {
      window.destroy();
    }
  });

  return window;
}

export function closeSettingsWindow(): void {
  getSettingsWindow()?.close();
}

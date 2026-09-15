import { app, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';

import { closeSettingsWindow, getSettingsWindow, showSettingsWindow } from './settings-window';
import { createMenuBar, type MenuBarController } from './menu-bar';
import { createOverlayController, type OverlayController } from './overlay-controller';
import { publishOverlayState, registerOverlayIpcHandlers } from './overlay-ipc';
import { connectedDisplays, displayOptionsWithPreference, serializeDisplayId } from './display';
import { DesktopPreferencesStore } from './desktop-preferences';
import { publishSettingsState, registerSettingsIpcHandlers } from './settings-ipc';
import { evaluateLoginItemSettings, shouldOpenSettingsAtStartup } from './login-item';
import { createStartupOverlayState } from './test-session-source';
import packageJson from '../../package.json';
import { IPC_CHANNELS, type SettingsState } from '../shared/ipc';
import type { OverlayState } from '../shared/overlay-ipc';
import type { SessionSnapshot } from '../shared/session';
import { PRIMARY_DISPLAY_ID } from '../shared/settings';

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let menuBar: MenuBarController | null = null;
let overlayController: OverlayController | null = null;
let removeOverlayIpcHandlers: (() => void) | null = null;
let removeSettingsIpcHandlers: (() => void) | null = null;
let removeAppIpcHandlers: (() => void) | null = null;
let desktopPreferences: DesktopPreferencesStore | null = null;
let overlayState: OverlayState = createStartupOverlayState(app.isPackaged);
let requestedLoginItemState: boolean | undefined;

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

function unavailableProviderState(): SettingsState['providers']['codex'] {
  return {
    status: 'unavailable',
    canConnect: false,
    canDisconnect: false,
  };
}

function getSettingsState(): SettingsState {
  const preferences = desktopPreferences?.get();
  const preferredDisplayId = preferences?.preferredDisplayId ?? PRIMARY_DISPLAY_ID;
  const loginSettings =
    typeof app.getLoginItemSettings === 'function' ? app.getLoginItemSettings() : undefined;
  const loginItemState =
    loginSettings === undefined
      ? { enabled: false }
      : evaluateLoginItemSettings(loginSettings, requestedLoginItemState);
  if (loginItemState.error === undefined) requestedLoginItemState = undefined;
  return {
    providers: {
      codex: unavailableProviderState(),
      claude: unavailableProviderState(),
    },
    displays: displayOptionsWithPreference(connectedDisplays(), preferredDisplayId),
    selectedDisplayId: preferredDisplayId,
    launchAtLogin: loginItemState.enabled,
    reduceMotion: preferences?.reduceMotion ?? false,
    ...(loginItemState.error ? { error: loginItemState.error } : {}),
  };
}

function publishCurrentSettings(): void {
  publishSettingsState(getSettingsWindow(), getSettingsState());
}

function registerIpcHandlers(): () => void {
  ipcMain.handle(IPC_CHANNELS.version, (event) => {
    assertSettingsSender(event);
    return app.isPackaged ? app.getVersion() : packageJson.version;
  });
  ipcMain.handle(IPC_CHANNELS.settingsOpen, (event, payload?: unknown) => {
    assertSettingsSender(event);
    if (payload !== undefined) throw new Error('Settings open request does not accept a payload');
    showSettingsWindow();
  });
  ipcMain.handle(IPC_CHANNELS.settingsClose, (event, payload?: unknown) => {
    assertSettingsSender(event);
    if (payload !== undefined) throw new Error('Settings close request does not accept a payload');
    closeSettingsWindow();
  });
  let isRegistered = true;
  return () => {
    if (!isRegistered) return;
    isRegistered = false;
    for (const channel of [
      IPC_CHANNELS.version,
      IPC_CHANNELS.settingsOpen,
      IPC_CHANNELS.settingsClose,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
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
    removeSettingsIpcHandlers?.();
    removeSettingsIpcHandlers = null;
    removeAppIpcHandlers?.();
    removeAppIpcHandlers = null;
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

    const startupLoginSettings = app.getLoginItemSettings();
    desktopPreferences = new DesktopPreferencesStore(app.getPath('userData'));
    const preferences = desktopPreferences.get();
    overlayState = { ...overlayState, reducedMotion: preferences.reduceMotion };
    overlayController = createOverlayController({
      preferredDisplayId: preferences.preferredDisplayId,
    });
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
    removeAppIpcHandlers = registerIpcHandlers();
    removeSettingsIpcHandlers = registerSettingsIpcHandlers({
      getWindow: getSettingsWindow,
      getState: getSettingsState,
      setDisplayPreference: (displayId) => {
        if (desktopPreferences === null) throw new Error('Desktop preferences are unavailable');
        if (
          displayId !== PRIMARY_DISPLAY_ID &&
          !connectedDisplays().some((display) => serializeDisplayId(display) === displayId)
        ) {
          throw new Error('Selected display is not connected');
        }
        desktopPreferences.setDisplayPreference(displayId);
        overlayController?.setPreferredDisplayId(displayId);
        const state = getSettingsState();
        publishSettingsState(getSettingsWindow(), state);
        return state;
      },
      setReduceMotion: (enabled) => {
        if (desktopPreferences === null) throw new Error('Desktop preferences are unavailable');
        desktopPreferences.setReduceMotion(enabled);
        overlayState = { ...overlayState, reducedMotion: enabled };
        publishOverlayState(overlayController?.getWindow() ?? null, overlayState);
        const state = getSettingsState();
        publishSettingsState(getSettingsWindow(), state);
        return state;
      },
      setLaunchAtLogin: (enabled) => {
        requestedLoginItemState = enabled;
        app.setLoginItemSettings({ openAtLogin: enabled });
        const state = getSettingsState();
        publishSettingsState(getSettingsWindow(), state);
        return state;
      },
    });
    const onDisplayTopologyChanged = (): void => publishCurrentSettings();
    screen.on('display-metrics-changed', onDisplayTopologyChanged);
    screen.on('display-added', onDisplayTopologyChanged);
    screen.on('display-removed', onDisplayTopologyChanged);
    app.once('will-quit', () => {
      screen.off('display-metrics-changed', onDisplayTopologyChanged);
      screen.off('display-added', onDisplayTopologyChanged);
      screen.off('display-removed', onDisplayTopologyChanged);
      desktopPreferences = null;
    });
    if (shouldOpenSettingsAtStartup(startupLoginSettings)) {
      showSettingsWindow();
    }
    app.on('activate', () => {
      showSettingsWindow();
    });
  });
}

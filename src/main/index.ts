import { app, ipcMain, powerMonitor, screen, type IpcMainInvokeEvent } from 'electron';

import { closeSettingsWindow, getSettingsWindow, showSettingsWindow } from './settings-window';
import { createMenuBar, type MenuBarController } from './menu-bar';
import { createOverlayController, type OverlayController } from './overlay-controller';
import {
  publishOverlayKeyboardEntry,
  publishOverlayState,
  registerOverlayIpcHandlers,
} from './overlay-ipc';
import { connectedDisplays, displayOptionsWithPreference, serializeDisplayId } from './display';
import { DesktopPreferencesStore } from './desktop-preferences';
import { publishSettingsState, registerSettingsIpcHandlers } from './settings-ipc';
import { evaluateLoginItemSettings } from './login-item';
import { createStartupOverlayState, isKeyboardEntryTestHookEnabled } from './test-session-source';
import packageJson from '../../package.json';
import { IPC_CHANNELS, type SettingsConnectionKey, type SettingsState } from '../shared/ipc';
import type { OverlayState } from '../shared/overlay-ipc';
import type { SessionSnapshot } from '../shared/session';
import { PRIMARY_DISPLAY_ID } from '../shared/settings';
import { createAppLifecycleController } from './app-lifecycle';
import { createRuntimeCoordinator, type RuntimeCoordinator } from './runtime/coordinator';
import type { Provider, Surface } from '../shared/session';
import {
  CodexDesktopMonitor,
  type CodexDesktopMonitorOptions,
} from './providers/codex/desktop-monitor';
import { CodexCliMonitor, type CodexCliMonitorOptions } from './providers/codex/cli-monitor';

const hasSingleInstanceLock = app.requestSingleInstanceLock();
const TEST_KEYBOARD_ENTRY_HOOK = Symbol.for('agent-status-tiles.test.keyboard-entry');
let menuBar: MenuBarController | null = null;
let overlayController: OverlayController | null = null;
let removeOverlayIpcHandlers: (() => void) | null = null;
let removeSettingsIpcHandlers: (() => void) | null = null;
let removeAppIpcHandlers: (() => void) | null = null;
let desktopPreferences: DesktopPreferencesStore | null = null;
let overlayState: OverlayState = createStartupOverlayState(app.isPackaged);
let requestedLoginItemState: boolean | undefined;
let removeRuntimeLifecycleListeners: (() => void) | null = null;
let runtimeCoordinator: RuntimeCoordinator | null = null;
let runtimeStartPromise: Promise<void> | null = null;
let monitoringCoverageWarning: string | undefined;
let isQuitting = false;
let runtimeInitialized = false;
const pendingConnectionActions = new Set<SettingsConnectionKey>();

const CONNECTION_TARGETS: Readonly<Record<SettingsConnectionKey, readonly [Provider, Surface]>> = {
  codexDesktop: ['codex', 'desktop'],
  codexCli: ['codex', 'cli'],
  claudeCode: ['claude', 'desktop'],
};

function desktopMonitorOptions(): CodexDesktopMonitorOptions {
  // Native E2E supplies a controlled app-server and rollout root. This path is
  // unavailable in packaged builds and is never received over renderer IPC.
  if (app.isPackaged || process.env.NODE_ENV !== 'test') return {};
  const binaryPath = process.env.AGENT_STATUS_TILES_TEST_CODEX_BINARY;
  const sessionsRoot = process.env.AGENT_STATUS_TILES_TEST_CODEX_SESSIONS_ROOT;
  if (!binaryPath || !sessionsRoot) return {};
  return {
    sessionsRoot,
    resolveBinary: async () => ({
      ok: true,
      binaryPath,
      bundlePath: '',
      bundleId: 'com.openai.codex',
      version: 'test',
    }),
  };
}

function cliMonitorOptions(): CodexCliMonitorOptions {
  if (app.isPackaged || process.env.NODE_ENV !== 'test') return {};
  const binaryPath = process.env.AGENT_STATUS_TILES_TEST_CODEX_CLI_BINARY;
  const sessionsRoot = process.env.AGENT_STATUS_TILES_TEST_CODEX_SESSIONS_ROOT;
  if (!binaryPath || !sessionsRoot) return {};
  return {
    sessionsRoot,
    resolveBinary: async () => ({ ok: true, binaryPath }),
  };
}

function isQualifyingSession(session: SessionSnapshot): boolean {
  return session.isTopLevel && !session.isArchived;
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

function unavailableProviderState(): SettingsState['providers'][SettingsConnectionKey] {
  return {
    status: 'unavailable',
    canConnect: false,
    canDisconnect: false,
  };
}

function connectionState(
  connection: SettingsConnectionKey,
): SettingsState['providers'][SettingsConnectionKey] {
  const coordinator = runtimeCoordinator;
  if (coordinator === null) return unavailableProviderState();
  const [provider, surface] = CONNECTION_TARGETS[connection];
  const key = `${provider}:${surface}` as const;
  const enabled = coordinator.getMonitoringState().partitions[key].enabled;
  if (!enabled) {
    return {
      status: connection === 'claudeCode' ? 'unavailable' : 'disconnected',
      canConnect: connection !== 'claudeCode',
      canDisconnect: false,
    };
  }
  const health = coordinator.getHealth()[key].status;
  return {
    status:
      health === 'available' ? 'connected' : health === 'starting' ? 'connecting' : 'unavailable',
    canConnect: false,
    canDisconnect: true,
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
  const codexConnectionIssues = (['codexDesktop', 'codexCli'] as const).flatMap((connection) => {
    const coordinator = runtimeCoordinator;
    if (coordinator === null) return [];
    const [provider, surface] = CONNECTION_TARGETS[connection];
    const key = `${provider}:${surface}` as const;
    const health = coordinator.getHealth()[key].status;
    if (!coordinator.getMonitoringState().partitions[key].enabled) return [];
    const label = connection === 'codexDesktop' ? 'Codex Desktop' : 'Codex CLI';
    // Partial catalog coverage is not a connection failure. Keep confirmed
    // sessions visible without showing a persistent Settings error.
    if (health !== 'error' && health !== 'unavailable') return [];
    return [
      `${label} connection or coverage is incomplete. Check the installation, then disconnect and reconnect.`,
    ];
  });
  const settingsError = [loginItemState.error, monitoringCoverageWarning, ...codexConnectionIssues]
    .filter((message): message is string => message !== undefined)
    .join(' ');
  return {
    providers: {
      codexDesktop: connectionState('codexDesktop'),
      codexCli: connectionState('codexCli'),
      claudeCode: connectionState('claudeCode'),
    },
    displays: displayOptionsWithPreference(connectedDisplays(), preferredDisplayId),
    selectedDisplayId: preferredDisplayId,
    launchAtLogin: loginItemState.enabled,
    reduceMotion: preferences?.reduceMotion ?? false,
    recentThreadLimit: preferences?.recentThreadLimit ?? 5,
    ...(settingsError ? { error: settingsError } : {}),
  };
}

function publishCurrentSettings(): void {
  publishSettingsState(getSettingsWindow(), getSettingsState());
}

function openSettingsWindow(): void {
  showSettingsWindow(publishCurrentSettings);
}

function registerIpcHandlers(): () => void {
  ipcMain.handle(IPC_CHANNELS.version, (event) => {
    assertSettingsSender(event);
    return app.isPackaged ? app.getVersion() : packageJson.version;
  });
  ipcMain.handle(IPC_CHANNELS.settingsOpen, (event, payload?: unknown) => {
    assertSettingsSender(event);
    if (payload !== undefined) throw new Error('Settings open request does not accept a payload');
    openSettingsWindow();
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
    openSettingsWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    // Electron can close BrowserWindows before emitting will-quit. Mark the
    // controller destroyed first so its closed callbacks cannot recreate a
    // replacement while the app is shutting down.
    isQuitting = true;
    removeRuntimeLifecycleListeners?.();
    removeRuntimeLifecycleListeners = null;
    void runtimeCoordinator?.stop();
    overlayController?.destroy();
  });

  const onWillQuit = (): void => {
    isQuitting = true;
    removeRuntimeLifecycleListeners?.();
    removeRuntimeLifecycleListeners = null;
    void runtimeCoordinator?.stop();
    Reflect.deleteProperty(globalThis, TEST_KEYBOARD_ENTRY_HOOK);
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
  };
  app.on('will-quit', onWillQuit);

  void app.whenReady().then(() => {
    if (isQuitting || runtimeInitialized) return;
    runtimeInitialized = true;
    if (process.platform === 'darwin') {
      app.dock?.hide();
    }

    desktopPreferences = new DesktopPreferencesStore(app.getPath('userData'));
    const preferences = desktopPreferences.get();
    overlayState = { ...overlayState, reducedMotion: preferences.reduceMotion };
    const lifecycle = createAppLifecycleController({
      recoverOverlay: () => overlayController?.recover(),
      openSettings: openSettingsWindow,
    });
    overlayController = createOverlayController({
      preferredDisplayId: preferences.preferredDisplayId,
      onKeyboardEntry: () => publishOverlayKeyboardEntry(overlayController?.getWindow() ?? null),
    });
    overlayController.setQualifyingSessionCount(qualifyingSessionCount(overlayState.sessions));
    const preserveFixtureOverlay = !app.isPackaged && overlayState.sessions.length > 0;
    runtimeCoordinator = createRuntimeCoordinator({
      appDataPath: app.getPath('userData'),
      recentThreadLimit: preferences.recentThreadLimit,
      monitors: [
        new CodexDesktopMonitor(desktopMonitorOptions()),
        new CodexCliMonitor(cliMonitorOptions()),
      ],
      onOverlayState: (state) => {
        if (preserveFixtureOverlay && state.sessions.length === 0) return;
        overlayState = { ...state, reducedMotion: desktopPreferences?.get().reduceMotion ?? false };
        overlayController?.setQualifyingSessionCount(qualifyingSessionCount(overlayState.sessions));
        publishOverlayState(overlayController?.getWindow() ?? null, overlayState);
        publishCurrentSettings();
      },
      onCoverageWarning: (omittedCount) => {
        monitoringCoverageWarning =
          omittedCount > 0
            ? `${omittedCount} additional sessions are hidden from the overlay.`
            : undefined;
        publishCurrentSettings();
      },
      onHealthChanged: () => publishCurrentSettings(),
    });
    removeOverlayIpcHandlers = registerOverlayIpcHandlers({
      getWindow: () => overlayController?.getWindow() ?? null,
      getState: () => overlayState,
      setHitRegions: (regions) => overlayController?.setHitRegions(regions) ?? false,
      onKeyboardExit: () => overlayController?.exitKeyboardMode(),
      onRendererReady: () => overlayController?.setRendererReady(),
    });
    menuBar = createMenuBar({
      showOverlay: () => overlayController?.enterKeyboardMode(),
      hideOverlay: () => overlayController?.setVisible(false),
      openSettings: openSettingsWindow,
      quit: () => app.quit(),
    });
    if (isKeyboardEntryTestHookEnabled(process.argv, process.env.NODE_ENV, app.isPackaged)) {
      Reflect.defineProperty(globalThis, TEST_KEYBOARD_ENTRY_HOOK, {
        configurable: true,
        value: () => overlayController?.enterKeyboardMode(),
      });
    }
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
      setRecentThreadLimit: (limit) => {
        if (desktopPreferences === null || runtimeCoordinator === null)
          throw new Error('Recent threads are unavailable');
        desktopPreferences.setRecentThreadLimit(limit);
        runtimeCoordinator.setRecentThreadLimit(limit);
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
      connectSurface: async (connection) => {
        if (connection === 'claudeCode') throw new Error('Connection is not available');
        await runtimeStartPromise;
        if (pendingConnectionActions.has(connection))
          throw new Error('Connection action is pending');
        const coordinator = runtimeCoordinator;
        if (coordinator === null) throw new Error('Monitoring is unavailable');
        const [provider, surface] = CONNECTION_TARGETS[connection];
        if (coordinator.getMonitoringState().partitions[`${provider}:${surface}`].enabled) {
          throw new Error('Connection is already enabled');
        }
        pendingConnectionActions.add(connection);
        try {
          await coordinator.connect(provider, surface);
          const state = getSettingsState();
          publishSettingsState(getSettingsWindow(), state);
          return state;
        } finally {
          pendingConnectionActions.delete(connection);
        }
      },
      disconnectSurface: async (connection) => {
        await runtimeStartPromise;
        if (pendingConnectionActions.has(connection))
          throw new Error('Connection action is pending');
        const coordinator = runtimeCoordinator;
        if (coordinator === null) throw new Error('Monitoring is unavailable');
        const [provider, surface] = CONNECTION_TARGETS[connection];
        if (!coordinator.getMonitoringState().partitions[`${provider}:${surface}`].enabled) {
          throw new Error('Connection is not enabled');
        }
        pendingConnectionActions.add(connection);
        try {
          await coordinator.disconnect(provider, surface);
          const state = getSettingsState();
          publishSettingsState(getSettingsWindow(), state);
          return state;
        } finally {
          pendingConnectionActions.delete(connection);
        }
      },
    });
    runtimeStartPromise = runtimeCoordinator.start().catch(() => undefined);
    const onDisplayTopologyChanged = (): void => publishCurrentSettings();
    const onActivate = (): void => lifecycle.handleActivate();
    const onSystemSuspend = (): void => {
      void runtimeCoordinator?.suspend();
    };
    const onSystemResume = (): void => {
      void runtimeCoordinator?.resume();
    };
    screen.on('display-metrics-changed', onDisplayTopologyChanged);
    screen.on('display-added', onDisplayTopologyChanged);
    screen.on('display-removed', onDisplayTopologyChanged);
    app.on('activate', onActivate);
    powerMonitor.on('suspend', onSystemSuspend);
    powerMonitor.on('resume', onSystemResume);
    removeRuntimeLifecycleListeners = (): void => {
      app.off('activate', onActivate);
      screen.off('display-metrics-changed', onDisplayTopologyChanged);
      screen.off('display-added', onDisplayTopologyChanged);
      screen.off('display-removed', onDisplayTopologyChanged);
      powerMonitor.off('suspend', onSystemSuspend);
      powerMonitor.off('resume', onSystemResume);
      lifecycle.destroy();
    };
    app.once('will-quit', () => {
      removeRuntimeLifecycleListeners?.();
      removeRuntimeLifecycleListeners = null;
      desktopPreferences = null;
    });
  });
}

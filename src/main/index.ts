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
import { surfaceKey, type SurfaceKey } from '../shared/monitoring';
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

/**
 * One Settings row per provider. Connecting a row enables every surface behind
 * it; each surface still keeps its own partition, baseline, cursors, and health.
 */
const CONNECTION_TARGETS: Readonly<
  Record<SettingsConnectionKey, readonly (readonly [Provider, Surface])[]>
> = {
  codex: [
    ['codex', 'desktop'],
    ['codex', 'cli'],
  ],
  claude: [
    ['claude', 'desktop'],
    ['claude', 'cli'],
  ],
};
const CONNECTION_LABEL: Readonly<Record<SettingsConnectionKey, string>> = {
  codex: 'Codex',
  claude: 'Claude Code',
};
/** Rows whose surfaces have live monitors. Claude stays unavailable until its adapter lands. */
const CONNECTABLE_CONNECTIONS: readonly SettingsConnectionKey[] = ['codex'];

function isTestRuntime(): boolean {
  return !app.isPackaged && process.env.NODE_ENV === 'test';
}

function desktopMonitorOptions(): CodexDesktopMonitorOptions {
  // Native E2E supplies a controlled app-server and rollout root. This path is
  // unavailable in packaged builds and is never received over renderer IPC.
  if (!isTestRuntime()) return {};
  const binaryPath = process.env.AGENT_STATUS_TILES_TEST_CODEX_BINARY;
  const sessionsRoot = process.env.AGENT_STATUS_TILES_TEST_CODEX_SESSIONS_ROOT;
  // A test run never reaches a real installation: an unsupplied surface is
  // reported as not installed, so it stays quietly unavailable.
  if (!binaryPath || !sessionsRoot) {
    return { resolveBinary: async () => ({ ok: false, code: 'bundle-not-found' }) };
  }
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
  if (!isTestRuntime()) return {};
  const binaryPath = process.env.AGENT_STATUS_TILES_TEST_CODEX_CLI_BINARY;
  const sessionsRoot = process.env.AGENT_STATUS_TILES_TEST_CODEX_SESSIONS_ROOT;
  if (!binaryPath || !sessionsRoot) {
    return { resolveBinary: async () => ({ ok: false, code: 'path-unavailable' }) };
  }
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

function surfaceKeysFor(connection: SettingsConnectionKey): readonly SurfaceKey[] {
  return CONNECTION_TARGETS[connection].map(([provider, surface]) => surfaceKey(provider, surface));
}

function enabledSurfaceKeysFor(
  coordinator: RuntimeCoordinator,
  connection: SettingsConnectionKey,
): readonly SurfaceKey[] {
  const partitions = coordinator.getMonitoringState().partitions;
  return surfaceKeysFor(connection).filter((key) => partitions[key].enabled);
}

function connectionState(
  connection: SettingsConnectionKey,
): SettingsState['providers'][SettingsConnectionKey] {
  const coordinator = runtimeCoordinator;
  if (coordinator === null) return unavailableProviderState();
  const enabledKeys = enabledSurfaceKeysFor(coordinator, connection);
  const canConnect = CONNECTABLE_CONNECTIONS.includes(connection);
  if (enabledKeys.length === 0) {
    return {
      status: canConnect ? 'disconnected' : 'unavailable',
      canConnect,
      canDisconnect: false,
    };
  }
  // The row is connected when any of its surfaces is monitoring; a surface
  // whose installation is absent stays quietly unavailable behind it.
  const statuses = enabledKeys.map((key) => coordinator.getHealth()[key].status);
  return {
    status: statuses.includes('available')
      ? 'connected'
      : statuses.includes('starting')
        ? 'connecting'
        : 'unavailable',
    canConnect: false,
    canDisconnect: true,
  };
}

function connectionIssue(connection: SettingsConnectionKey): string | undefined {
  const coordinator = runtimeCoordinator;
  if (coordinator === null) return undefined;
  const enabledKeys = enabledSurfaceKeysFor(coordinator, connection);
  if (enabledKeys.length === 0) return undefined;
  const statuses = enabledKeys.map((key) => coordinator.getHealth()[key].status);
  const label = CONNECTION_LABEL[connection];
  // Partial catalog coverage is not a connection failure, and one surface that
  // is simply not installed is not an error while another surface monitors.
  if (statuses.includes('error')) {
    return `${label} connection failed. Check the installation, then disconnect and reconnect.`;
  }
  if (statuses.every((status) => status === 'unavailable')) {
    return `${label} was not found. Install it, then disconnect and reconnect.`;
  }
  return undefined;
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
  const connectionIssues = CONNECTABLE_CONNECTIONS.map(connectionIssue);
  const settingsError = [loginItemState.error, monitoringCoverageWarning, ...connectionIssues]
    .filter((message): message is string => message !== undefined)
    .join(' ');
  return {
    providers: {
      codex: connectionState('codex'),
      claude: connectionState('claude'),
    },
    displays: displayOptionsWithPreference(connectedDisplays(), preferredDisplayId),
    selectedDisplayId: preferredDisplayId,
    launchAtLogin: loginItemState.enabled,
    reduceMotion: preferences?.reduceMotion ?? false,
    recentThreadLimit: preferences?.recentThreadLimit ?? 5,
    ...(settingsError ? { error: settingsError } : {}),
  };
}

/**
 * Enable every surface behind a provider row that is not yet enabled. If a
 * later surface's checkpoint fails, the surfaces enabled by this call are
 * disabled again so the row never ends up half-connected by accident.
 */
async function connectProviderSurfaces(
  coordinator: RuntimeCoordinator,
  connection: SettingsConnectionKey,
): Promise<void> {
  const partitions = coordinator.getMonitoringState().partitions;
  const missing = CONNECTION_TARGETS[connection].filter(
    ([provider, surface]) => !partitions[`${provider}:${surface}`].enabled,
  );
  const enabledHere: (readonly [Provider, Surface])[] = [];
  for (const [provider, surface] of missing) {
    try {
      await coordinator.connect(provider, surface);
      enabledHere.push([provider, surface]);
    } catch (error) {
      for (const [rollbackProvider, rollbackSurface] of enabledHere.reverse()) {
        await coordinator.disconnect(rollbackProvider, rollbackSurface).catch(() => undefined);
      }
      throw error;
    }
  }
}

/** Disable every enabled surface behind a provider row; the first failure is reported after all are attempted. */
async function disconnectProviderSurfaces(
  coordinator: RuntimeCoordinator,
  connection: SettingsConnectionKey,
): Promise<void> {
  let firstError: unknown;
  for (const [provider, surface] of CONNECTION_TARGETS[connection]) {
    if (!coordinator.getMonitoringState().partitions[`${provider}:${surface}`].enabled) continue;
    try {
      await coordinator.disconnect(provider, surface);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

/**
 * A checkpoint written before surfaces were bundled may have only one Codex
 * surface enabled. That connection now means both surfaces, so enable the
 * rest through the normal pending baseline; a missing installation stays
 * quietly unavailable, and nothing historical is shown as unread.
 */
async function completeProviderBundles(): Promise<void> {
  const coordinator = runtimeCoordinator;
  if (coordinator === null) return;
  for (const connection of CONNECTABLE_CONNECTIONS) {
    const enabledCount = enabledSurfaceKeysFor(coordinator, connection).length;
    if (enabledCount === 0 || enabledCount === surfaceKeysFor(connection).length) continue;
    if (pendingConnectionActions.has(connection)) continue;
    pendingConnectionActions.add(connection);
    try {
      await connectProviderSurfaces(coordinator, connection);
    } catch {
      // The partial bundle keeps working; the next Connect retries.
    } finally {
      pendingConnectionActions.delete(connection);
    }
  }
  publishCurrentSettings();
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
        if (!CONNECTABLE_CONNECTIONS.includes(connection))
          throw new Error('Connection is not available');
        await runtimeStartPromise;
        if (pendingConnectionActions.has(connection))
          throw new Error('Connection action is pending');
        const coordinator = runtimeCoordinator;
        if (coordinator === null) throw new Error('Monitoring is unavailable');
        if (
          enabledSurfaceKeysFor(coordinator, connection).length ===
          surfaceKeysFor(connection).length
        ) {
          throw new Error('Connection is already enabled');
        }
        pendingConnectionActions.add(connection);
        try {
          await connectProviderSurfaces(coordinator, connection);
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
        if (enabledSurfaceKeysFor(coordinator, connection).length === 0) {
          throw new Error('Connection is not enabled');
        }
        pendingConnectionActions.add(connection);
        try {
          await disconnectProviderSurfaces(coordinator, connection);
          const state = getSettingsState();
          publishSettingsState(getSettingsWindow(), state);
          return state;
        } finally {
          pendingConnectionActions.delete(connection);
        }
      },
    });
    runtimeStartPromise = runtimeCoordinator
      .start()
      .then(() => completeProviderBundles())
      .catch(() => undefined);
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

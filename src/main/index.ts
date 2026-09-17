import { join } from 'node:path';

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
import {
  CONNECTABLE_CONNECTIONS,
  completeProviderBundles,
  connectProvider,
  connectionIssue,
  connectionState,
  disconnectProvider,
  enabledSurfaceKeysFor,
  isConnectable,
  isFullyEnabled,
  repairProvider,
  type ProviderSetupMap,
} from './settings-connections';
import {
  resolveHookHelperPath,
  type HookHelperPathResolution,
} from './providers/claude/helper-path';
import {
  inspectClaudeHooks,
  installClaudeHooks,
  removeClaudeHooks,
} from './providers/claude/hook-installer';
import {
  defaultClaudeManagedLocations,
  inspectClaudeManagedHooks,
  type ClaudeManagedLocations,
} from './providers/claude/managed-settings';
import {
  ClaudeHelperError,
  claudeActionFailureSentence,
  claudeIssueSentence,
  helperReadiness,
  readinessOf,
  type ClaudeReadiness,
} from './providers/claude/readiness';
import {
  CodexDesktopMonitor,
  type CodexDesktopMonitorOptions,
} from './providers/codex/desktop-monitor';
import { CodexCliMonitor, type CodexCliMonitorOptions } from './providers/codex/cli-monitor';
import { ClaudeCliMonitor, ClaudeDesktopMonitor } from './providers/claude/surface-monitor';
import { ClaudeJournalDiscovery } from './providers/claude/journal-discovery';
import { ClaudeSessionNames } from './providers/claude/session-names';
import { ClaudeJournalCollector, claudeRetainedSet } from './providers/claude/journal-collector';

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
/** Provider-specific install/remove/issue hooks around partition changes; set once the runtime exists. */
let providerSetups: ProviderSetupMap = {};

interface ClaudeIntegration {
  /** Resolved on every use so a helper built or moved after launch is noticed. */
  helper: () => HookHelperPathResolution;
  /** Claude's configuration directory; undefined means the user's default. */
  configDirectory: string | undefined;
  /** Where the organization's managed settings would be. */
  managed: ClaudeManagedLocations;
  dataDirectory: string;
}
/** Per row, the last action failure with a known cause, shown until that row's next action. */
const providerActionIssues = new Map<SettingsConnectionKey, string>();

/**
 * Where the Claude hooks point and where they are installed. A test run
 * supplies both explicitly and reads managed settings from a `managed`
 * folder inside its configuration directory, never from the system
 * directory; without them, seeded-journal tests run the monitors with no
 * readiness check and no settings-file writes.
 */
function claudeIntegration(): ClaudeIntegration | undefined {
  const dataDirectory = app.getPath('userData');
  if (isTestRuntime()) {
    const helperPath = process.env.AGENT_STATUS_TILES_TEST_HOOK_HELPER;
    const configDirectory = process.env.AGENT_STATUS_TILES_TEST_CLAUDE_CONFIG_DIR;
    if (!helperPath || !configDirectory) return undefined;
    return {
      helper: () => ({ ok: true, path: helperPath }),
      configDirectory,
      managed: { directory: join(configDirectory, 'managed'), preferencesPaths: [] },
      dataDirectory,
    };
  }
  return {
    helper: () =>
      resolveHookHelperPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appRoot: app.getAppPath(),
        arch: process.arch,
      }),
    configDirectory: undefined,
    managed: defaultClaudeManagedLocations(),
    dataDirectory,
  };
}

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
  // One sentence per row: a failed action explains itself until the row's
  // next action; otherwise the live health sentence, if any.
  const connectionIssues = CONNECTABLE_CONNECTIONS.map(
    (connection) =>
      providerActionIssues.get(connection) ??
      connectionIssue(runtimeCoordinator, connection, providerSetups[connection]),
  );
  const settingsError = [loginItemState.error, monitoringCoverageWarning, ...connectionIssues]
    .filter((message): message is string => message !== undefined)
    .join(' ');
  return {
    providers: {
      codex: connectionState(runtimeCoordinator, 'codex'),
      claude: connectionState(runtimeCoordinator, 'claude'),
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
    // Both Claude surfaces share one listing of the journal directory.
    const claudeJournals = new ClaudeJournalDiscovery({ appDataPath: app.getPath('userData') });
    const claude = claudeIntegration();
    // Both surfaces start together; one settings-file read serves both.
    let readinessInFlight: Promise<ClaudeReadiness> | undefined;
    const checkClaudeReadiness =
      claude === undefined
        ? undefined
        : (): Promise<ClaudeReadiness> => {
            readinessInFlight ??= (async () => {
              const helper = claude.helper();
              const fromHelper = helperReadiness(helper);
              if (fromHelper !== undefined || !helper.ok) return fromHelper!;
              const [verification, managed] = await Promise.all([
                inspectClaudeHooks({
                  configDirectory: claude.configDirectory,
                  helperPath: helper.path,
                  dataDirectory: claude.dataDirectory,
                }),
                inspectClaudeManagedHooks(claude.managed),
              ]);
              return readinessOf(helper, verification, managed);
            })().finally(() => {
              readinessInFlight = undefined;
            });
            return readinessInFlight;
          };
    // Test runs point at an explicit configuration directory; a seeded-journal
    // test has none, so titles fall back to project names there.
    const claudeSessionNames =
      claude === undefined
        ? undefined
        : new ClaudeSessionNames({ configDirectory: claude.configDirectory });
    // Journals are collected only outside both cohorts of the listing the
    // sweep follows and outside the persisted cursors and sessions.
    const claudeCollector = new ClaudeJournalCollector({
      appDataPath: app.getPath('userData'),
      retained: claudeRetainedSet(
        () => runtimeCoordinator?.getMonitoringState() ?? null,
        claudeJournals,
      ),
    });
    const claudeDesktopMonitor = new ClaudeDesktopMonitor({
      appDataPath: app.getPath('userData'),
      discovery: claudeJournals,
      collector: claudeCollector,
      ...(claudeSessionNames === undefined ? {} : { sessionNames: claudeSessionNames }),
      ...(checkClaudeReadiness === undefined ? {} : { checkReadiness: checkClaudeReadiness }),
    });
    const claudeCliMonitor = new ClaudeCliMonitor({
      appDataPath: app.getPath('userData'),
      discovery: claudeJournals,
      collector: claudeCollector,
      ...(claudeSessionNames === undefined ? {} : { sessionNames: claudeSessionNames }),
      ...(checkClaudeReadiness === undefined ? {} : { checkReadiness: checkClaudeReadiness }),
    });
    providerSetups =
      claude === undefined
        ? {}
        : {
            claude: {
              install: async () => {
                // A check in flight may predate this install; do not let a
                // restarted surface inherit its answer.
                readinessInFlight = undefined;
                const helper = claude.helper();
                if (!helper.ok) throw new ClaudeHelperError(helper);
                await installClaudeHooks({
                  configDirectory: claude.configDirectory,
                  helperPath: helper.path,
                  dataDirectory: claude.dataDirectory,
                });
              },
              remove: async () => {
                await removeClaudeHooks({ configDirectory: claude.configDirectory });
              },
              issue: () => {
                const issue = claudeDesktopMonitor.lastIssue ?? claudeCliMonitor.lastIssue;
                return issue === undefined ? undefined : claudeIssueSentence(issue);
              },
              failureSentence: claudeActionFailureSentence,
            },
          };
    runtimeCoordinator = createRuntimeCoordinator({
      appDataPath: app.getPath('userData'),
      recentThreadLimit: preferences.recentThreadLimit,
      monitors: [
        new CodexDesktopMonitor(desktopMonitorOptions()),
        new CodexCliMonitor(cliMonitorOptions()),
        // Claude surfaces run only once their partitions are enabled.
        claudeDesktopMonitor,
        claudeCliMonitor,
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
        if (!isConnectable(connection)) throw new Error('Connection is not available');
        await runtimeStartPromise;
        if (pendingConnectionActions.has(connection))
          throw new Error('Connection action is pending');
        const coordinator = runtimeCoordinator;
        if (coordinator === null) throw new Error('Monitoring is unavailable');
        if (isFullyEnabled(coordinator, connection)) {
          throw new Error('Connection is already enabled');
        }
        pendingConnectionActions.add(connection);
        providerActionIssues.delete(connection);
        try {
          await connectProvider(coordinator, connection, providerSetups[connection]);
        } catch (error) {
          // A failure with a known cause is reported as one sentence in the
          // state; the row stays disconnected. Anything else is a retryable error.
          const sentence = providerSetups[connection]?.failureSentence?.(error, 'connect');
          if (sentence === undefined) throw error;
          providerActionIssues.set(connection, sentence);
        } finally {
          pendingConnectionActions.delete(connection);
        }
        const state = getSettingsState();
        publishSettingsState(getSettingsWindow(), state);
        return state;
      },
      repairSurface: async (connection) => {
        if (!isConnectable(connection)) throw new Error('Connection is not available');
        await runtimeStartPromise;
        if (pendingConnectionActions.has(connection))
          throw new Error('Connection action is pending');
        const coordinator = runtimeCoordinator;
        if (coordinator === null) throw new Error('Monitoring is unavailable');
        if (enabledSurfaceKeysFor(coordinator, connection).length === 0) {
          throw new Error('Connection is not enabled');
        }
        pendingConnectionActions.add(connection);
        providerActionIssues.delete(connection);
        try {
          await repairProvider(coordinator, connection, providerSetups[connection]);
        } catch (error) {
          const sentence = providerSetups[connection]?.failureSentence?.(error, 'repair');
          if (sentence === undefined) throw error;
          providerActionIssues.set(connection, sentence);
        } finally {
          pendingConnectionActions.delete(connection);
        }
        const state = getSettingsState();
        publishSettingsState(getSettingsWindow(), state);
        return state;
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
        providerActionIssues.delete(connection);
        try {
          await disconnectProvider(coordinator, connection, providerSetups[connection]);
        } catch (error) {
          // The partitions are already off; a removal that failed for a known
          // reason says what remains and what to do about it.
          const sentence = providerSetups[connection]?.failureSentence?.(error, 'disconnect');
          if (sentence === undefined) throw error;
          providerActionIssues.set(connection, sentence);
        } finally {
          pendingConnectionActions.delete(connection);
        }
        const state = getSettingsState();
        publishSettingsState(getSettingsWindow(), state);
        return state;
      },
    });
    const startedCoordinator = runtimeCoordinator;
    runtimeStartPromise = startedCoordinator
      .start()
      .then(() => completeProviderBundles(startedCoordinator))
      .then(() => publishCurrentSettings())
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

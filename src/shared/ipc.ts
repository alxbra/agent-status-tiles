export const IPC_CHANNELS = {
  version: 'app:version',
  settingsOpen: 'settings:open',
  settingsClose: 'settings:close',
  settingsGet: 'settings:get',
  settingsChanged: 'settings:changed',
  settingsDisplayChange: 'settings:display-change',
  settingsReduceMotionChange: 'settings:reduce-motion-change',
  settingsRecentThreadLimitChange: 'settings:recent-thread-limit-change',
  settingsLaunchAtLoginChange: 'settings:launch-at-login-change',
  settingsSurfaceConnect: 'settings:surface-connect',
  settingsSurfaceDisconnect: 'settings:surface-disconnect',
} as const;

export {
  isDisplayPreferenceChangeRequest,
  isLaunchAtLoginChangeRequest,
  isReduceMotionPreferenceChangeRequest,
  isRecentThreadLimitChangeRequest,
  isSerializedDisplayId,
  isSettingsState,
  isSettingsConnectionKey,
  isSettingsConnectionRequest,
  isSettingsDisconnectRequest,
  PRIMARY_DISPLAY_ID,
  type DisplayPreferenceChangeRequest,
  type LaunchAtLoginChangeRequest,
  type ReduceMotionPreferenceChangeRequest,
  type RecentThreadLimitChangeRequest,
  type SettingsDisplayOption,
  type SettingsProviderConnectionStatus,
  type SettingsProviderState,
  type SettingsConnectionKey,
  type SettingsConnectionRequest,
  type SettingsDisconnectRequest,
  type SettingsState,
} from './settings';

export interface AgentStatusTilesApi {
  getVersion(): Promise<string>;
  openSettings(): Promise<void>;
  closeSettings(): Promise<void>;
  getSettings(): Promise<import('./settings').SettingsState>;
  subscribeSettings(listener: (state: import('./settings').SettingsState) => void): () => void;
  setDisplayPreference(displayId: string): Promise<import('./settings').SettingsState>;
  setReduceMotion(enabled: boolean): Promise<import('./settings').SettingsState>;
  setRecentThreadLimit(limit: number): Promise<import('./settings').SettingsState>;
  setLaunchAtLogin(enabled: boolean): Promise<import('./settings').SettingsState>;
  connectSurface(
    connection: import('./settings').SettingsConnectionKey,
  ): Promise<import('./settings').SettingsState>;
  disconnectSurface(
    connection: import('./settings').SettingsConnectionKey,
    confirmed: true,
  ): Promise<import('./settings').SettingsState>;
}

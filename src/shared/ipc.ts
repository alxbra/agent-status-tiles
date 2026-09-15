export const IPC_CHANNELS = {
  version: 'app:version',
  settingsOpen: 'settings:open',
  settingsClose: 'settings:close',
  settingsGet: 'settings:get',
  settingsChanged: 'settings:changed',
  settingsDisplayChange: 'settings:display-change',
  settingsReduceMotionChange: 'settings:reduce-motion-change',
  settingsLaunchAtLoginChange: 'settings:launch-at-login-change',
} as const;

export {
  isDisplayPreferenceChangeRequest,
  isLaunchAtLoginChangeRequest,
  isReduceMotionPreferenceChangeRequest,
  isSerializedDisplayId,
  isSettingsState,
  PRIMARY_DISPLAY_ID,
  type DisplayPreferenceChangeRequest,
  type LaunchAtLoginChangeRequest,
  type ReduceMotionPreferenceChangeRequest,
  type SettingsDisplayOption,
  type SettingsProviderConnectionStatus,
  type SettingsProviderState,
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
  setLaunchAtLogin(enabled: boolean): Promise<import('./settings').SettingsState>;
}

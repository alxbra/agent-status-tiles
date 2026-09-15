export const IPC_CHANNELS = {
  version: 'app:version',
  settingsOpen: 'settings:open',
  settingsClose: 'settings:close',
} as const;

export interface AgentStatusTilesApi {
  getVersion(): Promise<string>;
  openSettings(): Promise<void>;
  closeSettings(): Promise<void>;
}

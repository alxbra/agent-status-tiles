import type { AgentStatusTilesApi } from '../shared/ipc';

declare global {
  interface Window {
    agentStatusTiles: AgentStatusTilesApi;
  }
}

export {};

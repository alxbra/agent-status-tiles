import type { AgentStatusTilesApi } from '../shared/ipc';
import type { AgentStatusTilesOverlayApi } from '../shared/overlay-ipc';

declare global {
  interface Window {
    agentStatusTiles: AgentStatusTilesApi;
    agentStatusTilesOverlay: AgentStatusTilesOverlayApi;
  }
}

export {};

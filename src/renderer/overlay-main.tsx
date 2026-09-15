import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { OverlayState } from '../shared/overlay-ipc';
import { StatusTiles } from './tiles/StatusTiles';
import type { OpenSessionTarget } from './tiles/interaction';
import './overlay.css';

const overlayApi = window.agentStatusTilesOverlay;

export function OverlayApp(): ReactElement {
  const [state, setState] = useState<OverlayState>({ sessions: [], reducedMotion: false });

  useEffect(() => {
    let mounted = true;
    let receivedPublishedState = false;
    const unsubscribe = overlayApi.subscribe((nextState) => {
      receivedPublishedState = true;
      if (mounted) setState(nextState);
    });
    void overlayApi
      .getState()
      .then((nextState) => {
        if (mounted && !receivedPublishedState) setState(nextState);
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const publishHitRegions = useCallback(
    (
      regions: readonly {
        x: number;
        y: number;
        width: number;
        height: number;
        sessionId: string;
      }[],
    ) => {
      // Session IDs are renderer-local lookup data and never cross the geometry channel.
      void overlayApi
        .publishHitRegions(regions.map(({ x, y, width, height }) => ({ x, y, width, height })))
        .catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    return () => {
      void overlayApi.publishHitRegions([]).catch(() => undefined);
    };
  }, []);

  const openSession = useCallback((target: OpenSessionTarget) => {
    return overlayApi.openSession(target);
  }, []);
  const dismissError = useCallback((sessionId: string) => {
    return overlayApi.dismissError({ sessionId });
  }, []);
  const keyboardExit = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);

  return (
    <StatusTiles
      sessions={state.sessions}
      reducedMotion={state.reducedMotion}
      onOpenSession={openSession}
      onDismissError={dismissError}
      onHitRegionsChange={publishHitRegions}
      onKeyboardExit={keyboardExit}
    />
  );
}

createRoot(document.getElementById('root')!).render(<OverlayApp />);

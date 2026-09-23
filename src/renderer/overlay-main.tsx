import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { OverlayHitRegion, OverlayState } from '../shared/overlay-ipc';
import { createOverlayHitRegionPublisher } from './overlay-hit-region-publisher';
import { translateAndClipHitRegions } from './overlay-hit-regions';
import { retryOverlayHandshake } from './overlay-readiness';
import { DynamicIsland } from './island/DynamicIsland';
import type { OpenSessionTarget } from './island/interaction';
import './styles.css';
import './overlay.css';

const overlayApi = window.agentStatusTilesOverlay;

export function OverlayApp(): ReactElement {
  const [state, setState] = useState<OverlayState>({ sessions: [], reducedMotion: false });
  const [keyboardEntryRevision, setKeyboardEntryRevision] = useState(0);
  const islandRegionsRef = useRef<readonly OverlayHitRegion[]>([]);
  const regionPublisherRef = useRef<ReturnType<typeof createOverlayHitRegionPublisher> | null>(
    null,
  );
  if (regionPublisherRef.current === null) {
    regionPublisherRef.current = createOverlayHitRegionPublisher((regions) =>
      overlayApi.publishHitRegions(regions),
    );
  }

  const publishCurrentHitRegions = useCallback(() => {
    const root = document.querySelector<HTMLElement>('.dynamic-island');
    const rootBounds = root?.getBoundingClientRect();
    const regions = translateAndClipHitRegions(
      islandRegionsRef.current,
      rootBounds ? { left: rootBounds.left, top: rootBounds.top } : null,
      { width: window.innerWidth, height: window.innerHeight },
    );
    regionPublisherRef.current?.update(regions);
  }, []);

  useEffect(() => {
    let mounted = true;
    let receivedPublishedState = false;
    let readinessStarted = false;
    let readinessRetryGroups = 0;
    const announceRendererReady = (): void => {
      if (!mounted || readinessStarted || readinessRetryGroups >= 2) return;
      readinessStarted = true;
      readinessRetryGroups += 1;
      void retryOverlayHandshake(() => overlayApi.rendererReady()).then((ready) => {
        if (!mounted || ready) return;
        readinessStarted = false;
        announceRendererReady();
      });
    };
    const unsubscribe = overlayApi.subscribe((nextState) => {
      receivedPublishedState = true;
      if (mounted) setState(nextState);
      announceRendererReady();
    });
    void retryOverlayHandshake(async () => {
      const nextState = await overlayApi.getState();
      if (!mounted) return;
      if (!receivedPublishedState) setState(nextState);
      announceRendererReady();
    });

    const unsubscribeKeyboardEntry = overlayApi.subscribeKeyboardEntry(() => {
      setKeyboardEntryRevision((revision) => revision + 1);
    });

    return () => {
      mounted = false;
      unsubscribe();
      unsubscribeKeyboardEntry();
    };
  }, []);

  const publishHitRegions = useCallback(
    (regions: readonly OverlayHitRegion[]) => {
      // The island deliberately keeps its callback root-local. The overlay
      // host translates those regions to viewport coordinates before IPC.
      islandRegionsRef.current = regions;
      publishCurrentHitRegions();
    },
    [publishCurrentHitRegions],
  );

  useEffect(() => {
    window.addEventListener('resize', publishCurrentHitRegions);
    publishCurrentHitRegions();

    return () => {
      window.removeEventListener('resize', publishCurrentHitRegions);
      islandRegionsRef.current = [];
      regionPublisherRef.current?.stop();
      void overlayApi.publishHitRegions([]).catch(() => undefined);
    };
  }, [publishCurrentHitRegions]);

  const openSession = useCallback((target: OpenSessionTarget) => {
    return overlayApi.openSession(target);
  }, []);
  const keyboardExit = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    void overlayApi.requestKeyboardExit().catch(() => undefined);
  }, []);

  return (
    <DynamicIsland
      sessions={state.sessions}
      reducedMotion={state.reducedMotion}
      onOpenSession={openSession}
      onHitRegionsChange={publishHitRegions}
      onKeyboardExit={keyboardExit}
      keyboardEntryRevision={keyboardEntryRevision}
    />
  );
}

createRoot(document.getElementById('root')!).render(<OverlayApp />);

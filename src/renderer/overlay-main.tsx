import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { OverlayState } from '../shared/overlay-ipc';
import { translateAndClipHitRegions, type OverlayPortalRect } from './overlay-hit-regions';
import { StatusTiles } from './tiles/StatusTiles';
import type { TileHitRegion } from './tiles/geometry';
import type { OpenSessionTarget } from './tiles/interaction';
import './overlay.css';

const overlayApi = window.agentStatusTilesOverlay;
const PORTAL_SELECTOR = '[data-slot="tooltip-content"], [data-slot="context-menu-content"]';

function portalElements(): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(PORTAL_SELECTOR)];
}

function visiblePortalRects(): readonly OverlayPortalRect[] {
  return portalElements().flatMap((element) => {
    if (!element.isConnected) return [];
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return [];
    const opacity = Number.parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity <= 0) return [];
    const bounds = element.getBoundingClientRect();
    return [
      {
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
    ];
  });
}

export function OverlayApp(): ReactElement {
  const [state, setState] = useState<OverlayState>({ sessions: [], reducedMotion: false });
  const tileRegionsRef = useRef<readonly TileHitRegion[]>([]);
  const lastPublishedRegionsRef = useRef('');
  const pendingRegionKeysRef = useRef(new Set<string>());
  const publicationSequenceRef = useRef(0);
  const portalResizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedPortalElementsRef = useRef(new Set<HTMLElement>());
  const animationFrameRef = useRef<number | null>(null);
  const animationDeadlineRef = useRef(0);
  const animationCooldownUntilRef = useRef(0);

  const syncPortalObservers = useCallback(() => {
    const observer = portalResizeObserverRef.current;
    if (observer === null) return;
    const nextElements = new Set(portalElements());
    for (const element of observedPortalElementsRef.current) {
      if (!nextElements.has(element)) observer.unobserve(element);
    }
    for (const element of nextElements) {
      if (!observedPortalElementsRef.current.has(element)) observer.observe(element);
    }
    observedPortalElementsRef.current = nextElements;
  }, []);

  const publishCurrentHitRegions = useCallback(() => {
    const root = document.querySelector<HTMLElement>('.status-tiles');
    const rootBounds = root?.getBoundingClientRect();
    const regions = translateAndClipHitRegions(
      tileRegionsRef.current,
      rootBounds && Number.isFinite(rootBounds.left) && Number.isFinite(rootBounds.top)
        ? { left: rootBounds.left, top: rootBounds.top }
        : null,
      visiblePortalRects(),
      { width: window.innerWidth, height: window.innerHeight },
    );
    const regionsKey = JSON.stringify(regions);
    if (
      regionsKey === lastPublishedRegionsRef.current ||
      pendingRegionKeysRef.current.has(regionsKey)
    ) {
      return;
    }
    const publicationSequence = publicationSequenceRef.current + 1;
    publicationSequenceRef.current = publicationSequence;
    pendingRegionKeysRef.current.add(regionsKey);
    void overlayApi
      .publishHitRegions(regions)
      .then((accepted) => {
        if (accepted && publicationSequence === publicationSequenceRef.current) {
          lastPublishedRegionsRef.current = regionsKey;
        }
      })
      .catch(() => undefined)
      .finally(() => pendingRegionKeysRef.current.delete(regionsKey));
  }, []);

  const schedulePortalAnimation = useCallback(() => {
    const now = performance.now();
    if (animationFrameRef.current !== null || now < animationCooldownUntilRef.current) return;
    animationDeadlineRef.current = now + 240;
    animationCooldownUntilRef.current = animationDeadlineRef.current;
    const sample = (): void => {
      animationFrameRef.current = null;
      publishCurrentHitRegions();
      if (performance.now() < animationDeadlineRef.current) {
        animationFrameRef.current = window.requestAnimationFrame(sample);
      }
    };
    animationFrameRef.current = window.requestAnimationFrame(sample);
  }, [publishCurrentHitRegions]);

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
    (regions: readonly TileHitRegion[]) => {
      // StatusTiles deliberately keeps its callback root-local. The overlay
      // host translates those regions to viewport coordinates before IPC.
      tileRegionsRef.current = regions;
      publishCurrentHitRegions();
    },
    [publishCurrentHitRegions],
  );

  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => {
      syncPortalObservers();
      publishCurrentHitRegions();
      schedulePortalAnimation();
    });
    portalResizeObserverRef.current = resizeObserver;
    syncPortalObservers();

    const mutationObserver = new MutationObserver((records) => {
      const affectsPortal = records.some((record) => {
        if (record.type === 'childList') return true;
        if (!(record.target instanceof Element)) return false;
        return (
          record.target.matches(PORTAL_SELECTOR) ||
          record.target.closest(PORTAL_SELECTOR) !== null ||
          record.target.querySelector(PORTAL_SELECTOR) !== null
        );
      });
      if (!affectsPortal) return;
      syncPortalObservers();
      publishCurrentHitRegions();
      schedulePortalAnimation();
    });
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    const handleResize = (): void => {
      syncPortalObservers();
      publishCurrentHitRegions();
      schedulePortalAnimation();
    };
    window.addEventListener('resize', handleResize);
    publishCurrentHitRegions();

    return () => {
      window.removeEventListener('resize', handleResize);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      portalResizeObserverRef.current = null;
      observedPortalElementsRef.current.clear();
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      tileRegionsRef.current = [];
      lastPublishedRegionsRef.current = '';
      pendingRegionKeysRef.current.clear();
      publicationSequenceRef.current += 1;
      void overlayApi.publishHitRegions([]).catch(() => undefined);
    };
  }, [publishCurrentHitRegions, schedulePortalAnimation, syncPortalObservers]);

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

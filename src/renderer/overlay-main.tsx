import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { OverlayState } from '../shared/overlay-ipc';
import { createOverlayHitRegionPublisher } from './overlay-hit-region-publisher';
import { translateAndClipHitRegions, type OverlayPortalRect } from './overlay-hit-regions';
import { retryOverlayHandshake } from './overlay-readiness';
import { StatusTiles } from './tiles/StatusTiles';
import { DISMISS_TILE_PORTALS_EVENT } from './tiles/events';
import type { TileHitRegion } from './tiles/geometry';
import type { OpenSessionTarget } from './tiles/interaction';
import './styles.css';
import './overlay.css';

const overlayApi = window.agentStatusTilesOverlay;
const PORTAL_SELECTOR = '[data-slot="context-menu-content"]';

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
  const [keyboardEntryRevision, setKeyboardEntryRevision] = useState(0);
  const tileRegionsRef = useRef<readonly TileHitRegion[]>([]);
  const currentRegionsRef = useRef<ReturnType<typeof translateAndClipHitRegions>>([]);
  const regionPublisherRef = useRef<ReturnType<typeof createOverlayHitRegionPublisher> | null>(
    null,
  );
  if (regionPublisherRef.current === null) {
    regionPublisherRef.current = createOverlayHitRegionPublisher((regions) =>
      overlayApi.publishHitRegions(regions),
    );
  }
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
    currentRegionsRef.current = regions;
    regionPublisherRef.current?.update(regions);
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
    const handlePointerMove = (event: globalThis.PointerEvent): void => {
      const hasOpenContextMenu = document.querySelector(
        '[data-slot="context-menu-content"][data-state="open"]',
      );
      if (hasOpenContextMenu === null) return;
      const isInsideInteractiveRegion = currentRegionsRef.current.some(
        (region) =>
          event.clientX >= region.x &&
          event.clientX < region.x + region.width &&
          event.clientY >= region.y &&
          event.clientY < region.y + region.height,
      );
      if (!isInsideInteractiveRegion) {
        window.dispatchEvent(new Event(DISMISS_TILE_PORTALS_EVENT));
      }
    };
    window.addEventListener('pointermove', handlePointerMove);
    publishCurrentHitRegions();

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handlePointerMove);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      portalResizeObserverRef.current = null;
      observedPortalElementsRef.current.clear();
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      tileRegionsRef.current = [];
      currentRegionsRef.current = [];
      regionPublisherRef.current?.stop();
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
    void overlayApi.requestKeyboardExit().catch(() => undefined);
  }, []);

  return (
    <StatusTiles
      sessions={state.sessions}
      reducedMotion={state.reducedMotion}
      onOpenSession={openSession}
      onDismissError={dismissError}
      onHitRegionsChange={publishHitRegions}
      onKeyboardExit={keyboardExit}
      keyboardEntryRevision={keyboardEntryRevision}
    />
  );
}

createRoot(document.getElementById('root')!).render(<OverlayApp />);

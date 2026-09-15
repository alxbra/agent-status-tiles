import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type WheelEvent,
} from 'react';

import type { SessionSnapshot } from '../../shared/session';
import {
  DEFAULT_STRIP_HEIGHT,
  DEFAULT_STRIP_WIDTH,
  layoutTiles,
  type TileHitRegion,
} from './geometry';
import {
  captureOpenTarget,
  updateFrozenSessionStatuses,
  visibleTileSessions,
  type OpenSessionTarget,
} from './interaction';
import { TileContextMenu } from './context-menu';
import { ProviderIcon, StatusIcon } from './icons';
import { PROVIDER_LABEL, sessionDisplayTitle, STATUS_COLOR, statusLabel } from './theme';
import './tiles.css';

export interface StatusTilesProps {
  sessions: readonly SessionSnapshot[];
  onOpenSession: (target: OpenSessionTarget) => void | Promise<unknown>;
  onDismissError: (sessionId: string) => void | Promise<unknown>;
  onHitRegionsChange: (regions: readonly TileHitRegion[]) => void;
  onKeyboardExit: () => void;
  reducedMotion?: boolean;
  /** Tests and the future overlay controller can provide a measured viewport. */
  width?: number;
  height?: number;
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    return (
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  });

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setPrefersReducedMotion(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);

  return prefersReducedMotion;
}

function sameTileSnapshot(left: SessionSnapshot, right: SessionSnapshot): boolean {
  return (
    left.id === right.id &&
    left.provider === right.provider &&
    left.surface === right.surface &&
    left.title === right.title &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt &&
    left.lastTurnStartedAt === right.lastTurnStartedAt &&
    left.completionId === right.completionId &&
    left.isTopLevel === right.isTopLevel &&
    left.isArchived === right.isArchived &&
    left.canOpen === right.canOpen
  );
}

function sameSnapshotList(
  left: readonly SessionSnapshot[],
  right: readonly SessionSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((session, index) => {
      const next = right[index];
      return next !== undefined && sameTileSnapshot(session, next);
    })
  );
}

function focusButton(button: HTMLButtonElement | null): void {
  if (button === null || typeof window === 'undefined') return;
  window.requestAnimationFrame(() => button.focus());
}

function pointIsInside(bounds: DOMRect, clientX: number, clientY: number): boolean {
  return (
    clientX >= bounds.left &&
    clientX <= bounds.right &&
    clientY >= bounds.top &&
    clientY <= bounds.bottom
  );
}

export function StatusTiles({
  sessions,
  onOpenSession,
  onDismissError,
  onHitRegionsChange,
  onKeyboardExit,
  reducedMotion,
  width = DEFAULT_STRIP_WIDTH,
  height,
}: StatusTilesProps): ReactElement | null {
  const rootRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const capturedTargetRef = useRef<OpenSessionTarget | null>(null);
  const capturedPointerIdRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);
  const focusWithinRef = useRef(false);
  const interactingRef = useRef(false);
  const visibleSessionsRef = useRef<readonly SessionSnapshot[]>([]);
  const lastHitRegionsRef = useRef<string>('');
  const lastHitRegionsCallbackRef = useRef(onHitRegionsChange);
  const [measuredHeight, setMeasuredHeight] = useState(height ?? DEFAULT_STRIP_HEIGHT);
  const [pointerY, setPointerY] = useState<number | undefined>();
  const [scrollOffset, setScrollOffset] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [isInteracting, setIsInteracting] = useState(false);
  const [displayedSessions, setDisplayedSessions] = useState<readonly SessionSnapshot[]>(() =>
    visibleTileSessions(sessions),
  );
  const prefersReducedMotion = usePrefersReducedMotion();
  const motionReduced = reducedMotion ?? prefersReducedMotion;
  const visibleSessions = useMemo(() => visibleTileSessions(sessions), [sessions]);
  visibleSessionsRef.current = visibleSessions;

  useLayoutEffect(() => {
    if (height !== undefined) {
      setMeasuredHeight(height);
      return undefined;
    }
    const root = rootRef.current;
    if (root === null) return undefined;
    const updateHeight = (): void => {
      if (root.clientHeight > 0) setMeasuredHeight(root.clientHeight);
    };
    updateHeight();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(root);
    return () => observer.disconnect();
  }, [height]);

  useEffect(() => {
    setDisplayedSessions((previous) => {
      const next = isInteracting
        ? updateFrozenSessionStatuses(previous, sessions)
        : visibleSessions;
      return sameSnapshotList(previous, next) ? previous : next;
    });
  }, [isInteracting, sessions, visibleSessions]);

  const baseLayout = useMemo(
    () =>
      layoutTiles(displayedSessions, {
        width,
        height: measuredHeight,
        scrollOffset,
      }),
    [displayedSessions, measuredHeight, scrollOffset, width],
  );
  const focusedTile =
    focusedIndex === null
      ? undefined
      : baseLayout.tiles.find((tile) => tile.index === focusedIndex);
  const effectivePointerY = pointerY ?? focusedTile?.centerY;
  const layout = useMemo(
    () =>
      layoutTiles(displayedSessions, {
        width,
        height: measuredHeight,
        pointer:
          effectivePointerY === undefined ? undefined : { x: width - 1, y: effectivePointerY },
        scrollOffset,
      }),
    [displayedSessions, effectivePointerY, measuredHeight, scrollOffset, width],
  );

  useEffect(() => {
    if (scrollOffset <= layout.maxStart) return;
    setScrollOffset(layout.maxStart);
  }, [layout.maxStart, scrollOffset]);

  useEffect(() => {
    const hitRegionsKey = JSON.stringify(layout.hitRegions);
    const callbackChanged = lastHitRegionsCallbackRef.current !== onHitRegionsChange;
    if (hitRegionsKey === lastHitRegionsRef.current && !callbackChanged) return;
    lastHitRegionsRef.current = hitRegionsKey;
    lastHitRegionsCallbackRef.current = onHitRegionsChange;
    onHitRegionsChange(layout.hitRegions);
  }, [layout.hitRegions, onHitRegionsChange]);

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      const bounds = root.getBoundingClientRect();
      const inside = pointIsInside(bounds, event.clientX, event.clientY);
      if (inside) {
        if (!pointerInsideRef.current) {
          pointerInsideRef.current = true;
          beginInteractionFromRef();
        }
        setPointerY(event.clientY - bounds.top);
      } else if (pointerInsideRef.current) {
        pointerInsideRef.current = false;
        leavePointerFromRef();
      }
    };
    const handlePointerUp = (event: globalThis.PointerEvent): void => {
      if (capturedPointerIdRef.current !== event.pointerId) return;
      const root = rootRef.current;
      const target = event.target;
      if (root === null || !(target instanceof Node) || !root.contains(target)) {
        capturedTargetRef.current = null;
        capturedPointerIdRef.current = null;
      }
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  useEffect(() => {
    if (focusedIndex === null) return;
    const localIndex = layout.tiles.findIndex((tile) => tile.index === focusedIndex);
    if (localIndex >= 0) focusButton(tileRefs.current[localIndex]);
  }, [focusedIndex, layout.tiles]);

  function beginInteractionFromRef(): void {
    if (interactingRef.current) return;
    interactingRef.current = true;
    setIsInteracting(true);
    setDisplayedSessions(visibleSessionsRef.current);
  }

  function leavePointerFromRef(): void {
    setPointerY(undefined);
    if (focusWithinRef.current) return;
    interactingRef.current = false;
    setIsInteracting(false);
    setDisplayedSessions(visibleSessionsRef.current);
    setFocusedIndex(null);
  }

  function endInteraction(): void {
    pointerInsideRef.current = false;
    leavePointerFromRef();
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    pointerInsideRef.current = true;
    beginInteractionFromRef();
    setPointerY(event.clientY - event.currentTarget.getBoundingClientRect().top);
  }

  function handlePointerDown(
    event: PointerEvent<HTMLButtonElement>,
    session: SessionSnapshot,
  ): void {
    if (event.button !== 0) return;
    beginInteractionFromRef();
    capturedTargetRef.current = captureOpenTarget(session);
    capturedPointerIdRef.current = event.pointerId;
  }

  function handleOpen(session: SessionSnapshot): void {
    const target =
      capturedTargetRef.current?.sessionId === session.id
        ? capturedTargetRef.current
        : captureOpenTarget(session);
    capturedTargetRef.current = null;
    capturedPointerIdRef.current = null;
    if (!session.canOpen) return;
    void Promise.resolve(onOpenSession(target)).catch(() => undefined);
  }

  function handleKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onKeyboardExit();
      return;
    }
    if (displayedSessions.length === 0) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    beginInteractionFromRef();
    const current = focusedIndex ?? layout.visibleStart;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(displayedSessions.length - 1, current + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, current - 1)
          : event.key === 'Home'
            ? 0
            : displayedSessions.length - 1;
    setFocusedIndex(next);
    setScrollOffset((previous) => {
      if (next < previous) return next;
      const lastVisible = previous + Math.max(1, layout.visibleCount) - 1;
      if (next > lastVisible) return Math.min(layout.maxStart, next - layout.visibleCount + 1);
      return previous;
    });
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>): void {
    if (layout.maxStart === 0) return;
    event.preventDefault();
    beginInteractionFromRef();
    const delta = Math.max(1, Math.round(Math.abs(event.deltaY) / 24));
    setScrollOffset((previous) => {
      const next = previous + (event.deltaY > 0 ? delta : -delta);
      return Math.min(layout.maxStart, Math.max(0, next));
    });
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    const nextTarget = event.relatedTarget;
    focusWithinRef.current = nextTarget instanceof Node && event.currentTarget.contains(nextTarget);
    if (!focusWithinRef.current && !pointerInsideRef.current) leavePointerFromRef();
  }

  if (displayedSessions.length === 0 && visibleSessions.length === 0) return null;

  const rootStyle = { width: `${width}px` } satisfies CSSProperties;
  return (
    <div
      ref={rootRef}
      className={`status-tiles${motionReduced ? ' status-tiles--reduced-motion' : ''}`}
      style={rootStyle}
      role="listbox"
      aria-label="Agent status sessions"
      tabIndex={-1}
      onKeyDown={handleKeyboard}
      onPointerEnter={() => {
        pointerInsideRef.current = true;
        beginInteractionFromRef();
      }}
      onPointerMove={handlePointerMove}
      onPointerLeave={(event) => {
        if (
          !pointIsInside(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)
        ) {
          endInteraction();
        }
      }}
      onFocusCapture={() => {
        focusWithinRef.current = true;
        beginInteractionFromRef();
      }}
      onBlurCapture={handleBlur}
      onWheel={handleWheel}
    >
      {layout.hasPrevious ? (
        <span
          className="status-tiles__indicator status-tiles__indicator--previous"
          aria-hidden="true"
        >
          ▲
        </span>
      ) : null}
      {layout.tiles.map((tile, localIndex) => {
        const session = displayedSessions[tile.index];
        if (session === undefined) return null;
        const title = sessionDisplayTitle(session.title, session.id);
        const expanded = tile.size >= 26;
        const targetStyle = {
          left: `${tile.hitRegion.x}px`,
          top: `${tile.hitRegion.y}px`,
          width: `${tile.hitRegion.width}px`,
          height: `${tile.hitRegion.height}px`,
        } satisfies CSSProperties;
        const surfaceStyle = {
          width: `${tile.size}px`,
          height: `${tile.size}px`,
          borderRadius: `${tile.radius}px`,
          backgroundColor: STATUS_COLOR[session.status],
        } satisfies CSSProperties;
        const button = (
          <button
            ref={(buttonElement) => {
              tileRefs.current[localIndex] = buttonElement;
            }}
            className="status-tiles__tile"
            style={targetStyle}
            type="button"
            role="option"
            aria-selected={focusedIndex === tile.index}
            aria-label={`${title}, ${PROVIDER_LABEL[session.provider]}, ${statusLabel(session.status)}`}
            tabIndex={
              focusedIndex === null
                ? localIndex === 0
                  ? 0
                  : -1
                : focusedIndex === tile.index
                  ? 0
                  : -1
            }
            data-session-id={session.id}
            data-status={session.status}
            data-expanded={expanded}
            onFocus={() => {
              setFocusedIndex(tile.index);
              focusWithinRef.current = true;
              beginInteractionFromRef();
            }}
            onPointerDown={(event) => handlePointerDown(event, session)}
            onPointerCancel={() => {
              capturedTargetRef.current = null;
              capturedPointerIdRef.current = null;
            }}
            onClick={() => handleOpen(session)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                capturedTargetRef.current = captureOpenTarget(session);
              }
            }}
          >
            <span className="status-tiles__tile-surface" style={surfaceStyle} aria-hidden="true">
              {expanded ? (
                <>
                  <ProviderIcon
                    provider={session.provider}
                    className="status-tiles__provider-icon"
                  />
                  <StatusIcon status={session.status} className="status-tiles__status-icon" />
                </>
              ) : null}
            </span>
          </button>
        );
        return (
          <TileContextMenu
            key={session.id}
            canDismiss={session.status === 'error'}
            onDismiss={() =>
              void Promise.resolve(onDismissError(session.id)).catch(() => undefined)
            }
            tooltip={title}
          >
            {button}
          </TileContextMenu>
        );
      })}
      {layout.hasNext ? (
        <span className="status-tiles__indicator status-tiles__indicator--next" aria-hidden="true">
          ▼
        </span>
      ) : null}
    </div>
  );
}

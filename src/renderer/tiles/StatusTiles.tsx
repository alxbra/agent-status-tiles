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
  type Ref,
  type WheelEvent,
} from 'react';

import type { SessionSnapshot } from '../../shared/session';
import {
  DEFAULT_STRIP_HEIGHT,
  DEFAULT_STRIP_WIDTH,
  DOCK_HOVER_WIDTH,
  layoutTabs,
  MAX_VISIBLE_TABS,
  normalizeStripWidth,
  REACH_PADDING,
  reachWidthFor,
  resolveHover,
  TAB_MOTION_MS,
  TAB_STAGGER_MS,
  tabHitRegion,
  type TabSlot,
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
  /** Monotonic signal from the native menu-bar keyboard-entry action. */
  keyboardEntryRevision?: number;
  reducedMotion?: boolean;
  /** Tests can provide a measured viewport instead of observing the root. */
  width?: number;
  height?: number;
  /** Optional visual-fixture override; the native overlay follows system appearance. */
  backgroundTone?: 'light' | 'dark';
}

const TAB_SELECTOR = '.status-tiles__tile';
/** Long enough to cover the slide plus the last staggered tab. */
const HIT_REGION_SETTLE_MS = TAB_MOTION_MS + TAB_STAGGER_MS * MAX_VISIBLE_TABS + 80;
/**
 * Toggling native mouse passthrough makes macOS report a window leave even
 * though the cursor is still over the dock. Forwarded pointer moves keep
 * arriving while the cursor is inside the window, so a leave only counts once
 * no move has followed it within this grace period.
 */
const EXIT_GRACE_MS = 250;

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

function usePrefersDarkAppearance(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (): void => setPrefersDark(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);
  return prefersDark;
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

/** Rendered tab rectangles already include the slide transform. */
function readRenderedHitRegions(root: HTMLElement, stripWidth: number): readonly TileHitRegion[] {
  const rootBounds = root.getBoundingClientRect();
  return [...root.querySelectorAll<HTMLButtonElement>(TAB_SELECTOR)].flatMap((tab) => {
    const sessionId = tab.dataset.sessionId;
    if (sessionId === undefined) return [];
    const bounds = tab.getBoundingClientRect();
    const region = tabHitRegion(
      {
        left: bounds.left - rootBounds.left,
        top: bounds.top - rootBounds.top,
        width: bounds.width,
        height: bounds.height,
      },
      stripWidth,
      sessionId,
    );
    return region === null ? [] : [region];
  });
}

function tabUnderPoint(root: HTMLElement, clientX: number, clientY: number): string | null {
  if (typeof document === 'undefined') return null;
  const element = document.elementFromPoint(clientX, clientY);
  const tab = element?.closest<HTMLElement>(TAB_SELECTOR) ?? null;
  if (tab === null || !root.contains(tab)) return null;
  return tab.dataset.sessionId ?? null;
}

interface StatusTabProps {
  session: SessionSnapshot;
  slot: TabSlot;
  localIndex: number;
  extended: boolean;
  focused: boolean;
  tabIndex: number;
  buttonRef: Ref<HTMLButtonElement>;
  onFocus: () => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onPointerEnter: () => void;
  onPointerLeave: (event: PointerEvent<HTMLButtonElement>) => void;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onDismiss: () => void;
}

function StatusTab({
  session,
  slot,
  localIndex,
  extended,
  focused,
  tabIndex,
  buttonRef,
  onFocus,
  onPointerDown,
  onPointerCancel,
  onPointerEnter,
  onPointerLeave,
  onClick,
  onKeyDown,
  onDismiss,
}: StatusTabProps): ReactElement {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const title = sessionDisplayTitle(session.title, session.id);

  useLayoutEffect(() => {
    const label = labelRef.current;
    if (label === null) return;
    setIsTruncated(label.scrollWidth > label.clientWidth);
  }, [title]);

  const style = {
    top: `${slot.y}px`,
    '--status-tiles-color': STATUS_COLOR[session.status],
    '--status-tiles-index': localIndex,
  } as CSSProperties;

  return (
    <TileContextMenu
      canDismiss={session.status === 'error'}
      onDismiss={onDismiss}
      tooltip={isTruncated ? title : null}
    >
      <button
        ref={buttonRef}
        className="status-tiles__tile"
        style={style}
        type="button"
        role="option"
        aria-selected={focused}
        aria-label={`${title}, ${PROVIDER_LABEL[session.provider]}, ${statusLabel(session.status)}`}
        tabIndex={tabIndex}
        data-session-id={session.id}
        data-provider={session.provider}
        data-surface={session.surface}
        data-status={session.status}
        data-extended={extended}
        onFocus={onFocus}
        onPointerDown={onPointerDown}
        onPointerCancel={onPointerCancel}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <ProviderIcon provider={session.provider} className="status-tiles__provider-icon" />
        <span ref={labelRef} className="status-tiles__label">
          {title}
        </span>
        <StatusIcon status={session.status} className="status-tiles__status-icon" />
      </button>
    </TileContextMenu>
  );
}

export function StatusTiles({
  sessions,
  onOpenSession,
  onDismissError,
  onHitRegionsChange,
  onKeyboardExit,
  keyboardEntryRevision,
  reducedMotion,
  width,
  height,
  backgroundTone,
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
  const [measuredWidth, setMeasuredWidth] = useState(width ?? DEFAULT_STRIP_WIDTH);
  const [dockActive, setDockActive] = useState(false);
  const [hoveredSessionId, setHoveredSessionIdState] = useState<string | null>(null);
  /** Mirrors the hovered tab synchronously for pointer handlers that fire back to back. */
  const hoveredSessionIdRef = useRef<string | null>(null);
  const reachWidthRef = useRef(DOCK_HOVER_WIDTH);
  /** Once the pointer has extended a tab, the reach zone stays engaged until the pointer leaves it. */
  const reachEngagedRef = useRef(false);
  const pendingExitRef = useRef<number | null>(null);
  const [reachWidth, setReachWidth] = useState(DOCK_HOVER_WIDTH);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const handledKeyboardEntryRevisionRef = useRef(0);
  /** Focus only selects a tab after deliberate keyboard entry or arrow navigation;
   * the hosting window can hand stray focus to the first button otherwise. */
  const keyboardModeRef = useRef(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const [displayedSessions, setDisplayedSessions] = useState<readonly SessionSnapshot[]>(() =>
    visibleTileSessions(sessions),
  );
  const prefersReducedMotion = usePrefersReducedMotion();
  const prefersDarkAppearance = usePrefersDarkAppearance();
  const motionReduced = prefersReducedMotion || reducedMotion === true;
  const isDark = (backgroundTone ?? (prefersDarkAppearance ? 'dark' : 'light')) === 'dark';
  const effectiveWidth = normalizeStripWidth(width ?? measuredWidth);
  const visibleSessions = useMemo(() => visibleTileSessions(sessions), [sessions]);
  const isStripMounted = displayedSessions.length > 0 || visibleSessions.length > 0;
  visibleSessionsRef.current = visibleSessions;

  useLayoutEffect(() => {
    if (height !== undefined) setMeasuredHeight(height);
    if (width !== undefined) setMeasuredWidth(width);
    if (height !== undefined && width !== undefined) return undefined;
    const root = rootRef.current;
    if (root === null) return undefined;
    const updateSize = (): void => {
      if (height === undefined && root.clientHeight > 0) setMeasuredHeight(root.clientHeight);
      if (width === undefined && root.clientWidth > 0) setMeasuredWidth(root.clientWidth);
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateSize);
    observer.observe(root);
    return () => observer.disconnect();
  }, [height, width, isStripMounted]);

  useEffect(() => {
    setDisplayedSessions((previous) => {
      const next = isInteracting
        ? updateFrozenSessionStatuses(previous, sessions)
        : visibleSessions;
      return sameSnapshotList(previous, next) ? previous : next;
    });
  }, [isInteracting, sessions, visibleSessions]);

  const layout = useMemo(
    () =>
      layoutTabs(displayedSessions, {
        width: effectiveWidth,
        height: measuredHeight,
        scrollOffset,
      }),
    [displayedSessions, effectiveWidth, measuredHeight, scrollOffset],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const active = dockActive || focusedIndex !== null;

  useEffect(() => {
    if (scrollOffset <= layout.maxStart) return;
    setScrollOffset(layout.maxStart);
  }, [layout.maxStart, scrollOffset]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      onHitRegionsChange(layout.hitRegions);
      return undefined;
    }
    let frame = 0;
    const startedAt = performance.now();
    const publish = (): void => {
      const renderedRegions = readRenderedHitRegions(root, effectiveWidth);
      const reachWidth = reachWidthFor(
        [...root.querySelectorAll<HTMLElement>(TAB_SELECTOR)].map((tab) => tab.offsetWidth),
        effectiveWidth,
      );
      if (reachWidthRef.current !== reachWidth) {
        reachWidthRef.current = reachWidth;
        setReachWidth(reachWidth);
      }
      root.dataset.reachWidth = String(reachWidth);
      const regions =
        renderedRegions.length === layout.hitRegions.length ? renderedRegions : layout.hitRegions;
      const regionsKey = JSON.stringify(regions);
      const callbackChanged = lastHitRegionsCallbackRef.current !== onHitRegionsChange;
      if (regionsKey !== lastHitRegionsRef.current || callbackChanged) {
        lastHitRegionsRef.current = regionsKey;
        lastHitRegionsCallbackRef.current = onHitRegionsChange;
        onHitRegionsChange(regions);
      }
      if (performance.now() - startedAt < HIT_REGION_SETTLE_MS) {
        frame = window.requestAnimationFrame(publish);
      }
    };
    publish();
    return () => window.cancelAnimationFrame(frame);
  }, [layout, effectiveWidth, active, hoveredSessionId, focusedIndex, onHitRegionsChange]);

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      cancelPendingExit();
      const bounds = root.getBoundingClientRect();
      const layout = layoutRef.current;
      const extended = reachEngagedRef.current;
      const resolution = resolveHover(
        layout,
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        { stripWidth: bounds.width, extended, reachWidth: reachWidthRef.current },
      );
      // Before a tab is extended only the tab element itself extends it; once
      // extended, the pointer's row inside the reach zone selects the tab.
      const hovered = extended
        ? resolution.hoveredIndex === null
          ? null
          : (layout.slots[resolution.hoveredIndex]?.sessionId ?? null)
        : tabUnderPoint(root, event.clientX, event.clientY);
      const inside = hovered !== null || resolution.inside;
      if (inside) {
        if (!pointerInsideRef.current) {
          pointerInsideRef.current = true;
          beginInteractionFromRef();
        }
        if (hovered !== null) reachEngagedRef.current = true;
        setDockActive(true);
        setHoveredSessionId(hovered);
      } else if (pointerInsideRef.current) {
        pointerInsideRef.current = false;
        leavePointerFromRef();
      }
    };
    const handlePointerExit = (event: globalThis.PointerEvent): void => {
      if (!pointerInsideRef.current) return;
      // Toggling native mouse passthrough emits a window leave while the
      // cursor is still over the dock, so only a leave reported outside the
      // hover zone counts as the cursor actually going away.
      if (pointStillInsideDock(event.clientX, event.clientY)) return;
      schedulePendingExit();
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
    document.documentElement.addEventListener('pointerleave', handlePointerExit);
    return () => {
      cancelPendingExit();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.documentElement.removeEventListener('pointerleave', handlePointerExit);
    };
  }, []);

  useEffect(() => {
    if (focusedIndex === null) return;
    const localIndex = layout.slots.findIndex((slot) => slot.index === focusedIndex);
    if (localIndex >= 0) focusButton(tileRefs.current[localIndex]);
  }, [focusedIndex, layout.slots]);

  useEffect(() => {
    if (
      keyboardEntryRevision === undefined ||
      keyboardEntryRevision <= handledKeyboardEntryRevisionRef.current ||
      layout.slots.length === 0
    ) {
      return;
    }
    handledKeyboardEntryRevisionRef.current = keyboardEntryRevision;
    keyboardModeRef.current = true;
    setScrollOffset(0);
    setFocusedIndex(0);
  }, [keyboardEntryRevision, layout.slots]);

  /** Whether a viewport point keeps the dock revealed in its current mode. */
  function pointStillInsideDock(clientX: number, clientY: number): boolean {
    const root = rootRef.current;
    if (root === null) return false;
    const bounds = root.getBoundingClientRect();
    return resolveHover(
      layoutRef.current,
      { x: clientX - bounds.left, y: clientY - bounds.top },
      {
        stripWidth: bounds.width,
        extended: reachEngagedRef.current,
        reachWidth: reachWidthRef.current,
      },
    ).inside;
  }

  function cancelPendingExit(): void {
    if (pendingExitRef.current === null) return;
    window.clearTimeout(pendingExitRef.current);
    pendingExitRef.current = null;
  }

  function schedulePendingExit(): void {
    if (pendingExitRef.current !== null || !pointerInsideRef.current) return;
    pendingExitRef.current = window.setTimeout(() => {
      pendingExitRef.current = null;
      if (!pointerInsideRef.current) return;
      pointerInsideRef.current = false;
      leavePointerFromRef();
    }, EXIT_GRACE_MS);
  }

  function setHoveredSessionId(sessionId: string | null): void {
    hoveredSessionIdRef.current = sessionId;
    setHoveredSessionIdState(sessionId);
  }

  function beginInteractionFromRef(): void {
    if (interactingRef.current) return;
    interactingRef.current = true;
    setIsInteracting(true);
    setDisplayedSessions(visibleSessionsRef.current);
  }

  function leavePointerFromRef(): void {
    reachEngagedRef.current = false;
    setDockActive(false);
    setHoveredSessionId(null);
    if (focusWithinRef.current) return;
    interactingRef.current = false;
    setIsInteracting(false);
    setDisplayedSessions(visibleSessionsRef.current);
    setFocusedIndex(null);
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

  /** A tab can receive the pointer without a preceding move, e.g. when the
   * overlay appears under a resting cursor, so enter/leave also drive hover. */
  function handleTabPointerEnter(session: SessionSnapshot): void {
    pointerInsideRef.current = true;
    reachEngagedRef.current = true;
    beginInteractionFromRef();
    setDockActive(true);
    setHoveredSessionId(session.id);
  }

  function handleTabPointerLeave(event: PointerEvent<HTMLButtonElement>): void {
    const next = event.relatedTarget;
    const overTab = next instanceof Element && next.closest(TAB_SELECTOR) !== null;
    if (overTab) return;
    // Still inside the reach zone (including the spurious leave that native
    // passthrough toggling emits): the following pointer move picks the row.
    if (pointStillInsideDock(event.clientX, event.clientY)) return;
    // The cursor left the window or jumped far away, unless a forwarded move
    // proves otherwise within the grace period.
    schedulePendingExit();
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
      keyboardModeRef.current = false;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      onKeyboardExit();
      return;
    }
    if (displayedSessions.length === 0) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    keyboardModeRef.current = true;
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
    if (layout.maxStart === 0 || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
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
    focusWithinRef.current =
      keyboardModeRef.current &&
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget);
    if (!focusWithinRef.current) keyboardModeRef.current = false;
    if (!focusWithinRef.current && !pointerInsideRef.current) leavePointerFromRef();
  }

  if (!isStripMounted) return null;

  const className = [
    'status-tiles',
    motionReduced ? 'status-tiles--reduced-motion' : '',
    isDark ? 'status-tiles--dark' : '',
    active ? 'status-tiles--active' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const previousIndicatorStyle = {
    top: `${Math.max(0, layout.top - 12)}px`,
  } satisfies CSSProperties;
  const nextIndicatorStyle = {
    top: `${Math.min(Math.max(0, measuredHeight - 10), layout.bottom + 4)}px`,
  } satisfies CSSProperties;

  return (
    <div
      ref={rootRef}
      className={className}
      role="listbox"
      aria-label="Agent status sessions"
      tabIndex={-1}
      data-active={active}
      onKeyDown={handleKeyboard}
      onFocusCapture={() => {
        if (!keyboardModeRef.current) return;
        focusWithinRef.current = true;
        beginInteractionFromRef();
      }}
      onBlurCapture={handleBlur}
      onWheel={handleWheel}
    >
      {/* DEBUG: visualizes the reach zone while a tab is extended; remove before merge. */}
      {hoveredSessionId !== null ? (
        <div
          className="status-tiles__reach-zone"
          style={{
            left: `${Math.max(0, effectiveWidth - reachWidth)}px`,
            top: `${Math.max(0, layout.top - REACH_PADDING)}px`,
            width: `${Math.min(effectiveWidth, reachWidth)}px`,
            height: `${Math.min(measuredHeight, layout.bottom + REACH_PADDING) - Math.max(0, layout.top - REACH_PADDING)}px`,
          }}
          aria-hidden="true"
        />
      ) : null}
      {layout.hasPrevious ? (
        <span
          className="status-tiles__indicator status-tiles__indicator--previous"
          style={previousIndicatorStyle}
          aria-hidden="true"
        >
          ▲
        </span>
      ) : null}
      {layout.slots.map((slot, localIndex) => {
        const session = displayedSessions[slot.index];
        if (session === undefined) return null;
        const focused = focusedIndex === slot.index;
        return (
          <StatusTab
            key={session.id}
            session={session}
            slot={slot}
            localIndex={localIndex}
            extended={focused || hoveredSessionId === session.id}
            focused={focused}
            tabIndex={focusedIndex === null ? (localIndex === 0 ? 0 : -1) : focused ? 0 : -1}
            buttonRef={(buttonElement) => {
              tileRefs.current[localIndex] = buttonElement;
            }}
            onFocus={() => {
              if (!keyboardModeRef.current) return;
              setFocusedIndex(slot.index);
              focusWithinRef.current = true;
              beginInteractionFromRef();
            }}
            onPointerDown={(event) => handlePointerDown(event, session)}
            onPointerCancel={() => {
              capturedTargetRef.current = null;
              capturedPointerIdRef.current = null;
            }}
            onPointerEnter={() => handleTabPointerEnter(session)}
            onPointerLeave={handleTabPointerLeave}
            onClick={() => handleOpen(session)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                capturedTargetRef.current = captureOpenTarget(session);
              }
            }}
            onDismiss={() =>
              void Promise.resolve(onDismissError(session.id)).catch(() => undefined)
            }
          />
        );
      })}
      {layout.hasNext ? (
        <span
          className="status-tiles__indicator status-tiles__indicator--next"
          style={nextIndicatorStyle}
          aria-hidden="true"
        >
          ▼
        </span>
      ) : null}
    </div>
  );
}

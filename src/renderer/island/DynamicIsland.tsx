import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
} from 'react';
// Latin only: the other subsets are unused and a tiny one would be inlined as a
// data: URL that the overlay's font-src policy blocks.
import '@fontsource/fira-code/latin-500.css';

import type { OverlayHitRegion } from '../../shared/overlay-ipc';
import type { Provider, SessionSnapshot } from '../../shared/session';
import { captureOpenTarget, visibleIslandSessions, type OpenSessionTarget } from './interaction';
import {
  columnTarget,
  completionSnapshot,
  finishedHarnesses,
  HARNESS_NAME,
  HARNESS_ORDER,
  summarizeHarnesses,
  type CompletionSnapshot,
  type HarnessColumn,
  type HarnessTone,
} from './summary';
import { SleepingSprite } from './SleepingSprite';
import { FINISHED_CUE_MS, TONE_COLOR, type DotTone } from './theme';
import './island.css';

export interface DynamicIslandProps {
  sessions: readonly SessionSnapshot[];
  onOpenSession: (target: OpenSessionTarget) => void | Promise<unknown>;
  onHitRegionsChange: (regions: readonly OverlayHitRegion[]) => void;
  onKeyboardExit: () => void;
  /** Monotonic signal from the native menu-bar keyboard-entry action. */
  keyboardEntryRevision?: number;
  reducedMotion?: boolean;
  /** Called once for every update in which at least one turn finished. */
  onTurnFinished?: () => void;
}

const ISLAND_HEIGHT = 32;
const ISLAND_MIN_WIDTH = 48;
/** Plus each column button's 6 px padding, the content sits 14 px from the edge. */
const ISLAND_PADDING_X = 8;
const ISLAND_MOTION_MS = 420;

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setPrefersReducedMotion(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);
  return prefersReducedMotion;
}

/** A column shows only while its harness is active or showing the green cue. */
type ShownTone = Exclude<DotTone, 'idle'>;

const TONE_WORDS: Record<ShownTone, string> = {
  working: 'working',
  finished: 'finished a turn',
  'needs-input': 'needs input',
};

interface HarnessCellProps {
  column: HarnessColumn;
  tone: ShownTone;
  side: 'start' | 'end';
  canOpen: boolean;
  buttonRef: Ref<HTMLButtonElement>;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

function HarnessCell({
  column,
  tone,
  side,
  canOpen,
  buttonRef,
  onPointerDown,
  onPointerCancel,
  onClick,
}: HarnessCellProps): ReactElement {
  const name = HARNESS_NAME[column.provider];
  // A tone change is a new dot, so it scales in again.
  const dot = <span key={tone} className="dynamic-island__dot" data-tone={tone} />;
  const label = <span className="dynamic-island__name">{name}</span>;
  // The columns mirror each other around the island's center; each one opens
  // its own harness's thread. The name takes its dot's color.
  return (
    <button
      ref={buttonRef}
      className="dynamic-island__harness"
      type="button"
      aria-label={`${name} ${TONE_WORDS[tone]}`}
      aria-disabled={!canOpen}
      data-provider={column.provider}
      data-tone={tone}
      data-side={side}
      style={{ '--dynamic-island-dot': TONE_COLOR[tone] } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
    >
      {side === 'start' ? dot : label}
      {side === 'start' ? label : dot}
    </button>
  );
}

/** Harnesses showing the green cue: the tone they finished with and the finished thread. */
type CueMap = ReadonlyMap<Provider, { tone: HarnessTone; session: SessionSnapshot }>;

/**
 * The green cue lasts while the harness keeps the tone it finished with; a
 * harness waiting for input never turns green, because a question outranks it.
 */
function displayTone(column: HarnessColumn, cued: CueMap): DotTone {
  return column.tone !== 'needs-input' && cued.get(column.provider)?.tone === column.tone
    ? 'finished'
    : column.tone;
}

const ENTRY_RANK: Record<HarnessTone, number> = { 'needs-input': 0, working: 1, idle: 2 };

/**
 * Keyboard entry lands on the harness most worth opening: one that can open
 * at all, then a question before work before idle, then the newest thread.
 */
function keyboardEntryHarness(
  columns: readonly HarnessColumn[],
  canOpen: (column: HarnessColumn) => boolean,
): Provider {
  const rank = (column: HarnessColumn): [number, number, number] => [
    canOpen(column) ? 0 : 1,
    ENTRY_RANK[column.tone],
    -(column.latest?.updatedAt ?? -Infinity),
  ];
  let best = columns[0]!;
  for (const column of columns.slice(1)) {
    const [a, b] = [rank(column), rank(best)];
    if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) {
      best = column;
    }
  }
  return best.provider;
}

export function DynamicIsland({
  sessions,
  onOpenSession,
  onHitRegionsChange,
  onKeyboardExit,
  keyboardEntryRevision,
  reducedMotion,
  onTurnFinished,
}: DynamicIslandProps): ReactElement | null {
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const cellRefs = useRef(new Map<Provider, HTMLButtonElement>());
  const capturedTargetRef = useRef<OpenSessionTarget | null>(null);
  /** The latest render's target rule, for the keyboard-entry frame callback. */
  const openableTargetRef = useRef<(column: HarnessColumn) => OpenSessionTarget | null>(() => null);
  const handledKeyboardEntryRevisionRef = useRef(0);
  /** The latest exit callback, so a pending focus repair survives a re-render. */
  const keyboardExitRef = useRef(onKeyboardExit);
  useLayoutEffect(() => {
    keyboardExitRef.current = onKeyboardExit;
  });
  const [contentWidth, setContentWidth] = useState(0);
  const prefersReducedMotion = usePrefersReducedMotion();
  const motionReduced = prefersReducedMotion || reducedMotion === true;

  const columns = useMemo(() => summarizeHarnesses(sessions), [sessions]);
  const completionsRef = useRef<CompletionSnapshot | null>(null);
  const cueTimersRef = useRef(new Map<Provider, number>());
  const [cued, setCued] = useState<CueMap>(() => new Map());
  const hasSessions = visibleIslandSessions(sessions).length > 0;
  const width = Math.max(ISLAND_MIN_WIDTH, Math.ceil(contentWidth) + ISLAND_PADDING_X * 2);

  const toneOf = (column: HarnessColumn): DotTone => displayTone(column, cued);
  // Idle harnesses are hidden; with none left, the island sleeps.
  const shownColumns = useMemo(
    () => columns.filter((column) => displayTone(column, cued) !== 'idle'),
    [columns, cued],
  );

  // A layout effect, so the green cue replaces the new tone before it paints.
  useLayoutEffect(() => {
    const finished = finishedHarnesses(completionsRef.current, sessions);
    completionsRef.current = completionSnapshot(completionsRef.current, sessions);
    if (finished.size === 0) return;
    onTurnFinished?.();
    // Every harness that finished a turn shows green for a moment, then its
    // current tone; finishing again restarts its moment.
    for (const provider of finished.keys()) {
      window.clearTimeout(cueTimersRef.current.get(provider));
      cueTimersRef.current.set(
        provider,
        window.setTimeout(() => {
          cueTimersRef.current.delete(provider);
          setCued((current) => {
            const next = new Map(current);
            next.delete(provider);
            return next;
          });
        }, FINISHED_CUE_MS),
      );
    }
    setCued((current) => {
      const next = new Map(current);
      for (const column of columns) {
        const session = finished.get(column.provider);
        if (session !== undefined) next.set(column.provider, { tone: column.tone, session });
      }
      return next;
    });
  }, [sessions, columns, onTurnFinished]);

  // Once a harness's tone moves away from the one it finished with, its green
  // moment is over for good, even if the tone later comes back.
  useLayoutEffect(() => {
    const ended = columns.filter(
      (column) => cued.has(column.provider) && cued.get(column.provider)?.tone !== column.tone,
    );
    if (ended.length === 0) return;
    for (const { provider } of ended) {
      window.clearTimeout(cueTimersRef.current.get(provider));
      cueTimersRef.current.delete(provider);
    }
    setCued((current) => {
      const next = new Map(current);
      for (const { provider } of ended) next.delete(provider);
      return next;
    });
  }, [columns, cued]);

  useEffect(() => {
    const timers = cueTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null) return undefined;
    const update = (): void => setContentWidth(content.scrollWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasSessions]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const pill = pillRef.current;
    if (root === null || pill === null) {
      onHitRegionsChange([]);
      return undefined;
    }
    let lastKey = '';
    const publish = (): void => {
      const rootBounds = root.getBoundingClientRect();
      const bounds = pill.getBoundingClientRect();
      const region: OverlayHitRegion = {
        x: bounds.left - rootBounds.left,
        y: bounds.top - rootBounds.top,
        width: bounds.width,
        height: bounds.height,
      };
      const key = JSON.stringify(region);
      if (key === lastKey) return;
      lastKey = key;
      onHitRegionsChange([region]);
    };
    publish();
    // The pill resizes on every frame of the spring and the root follows the
    // window, so observing both keeps the native region current even when the
    // spring ran while the overlay was hidden.
    const observer = new ResizeObserver(publish);
    observer.observe(root);
    observer.observe(pill);
    root.addEventListener('transitionend', publish);
    document.addEventListener('visibilitychange', publish);
    return () => {
      observer.disconnect();
      root.removeEventListener('transitionend', publish);
      document.removeEventListener('visibilitychange', publish);
    };
  }, [onHitRegionsChange, hasSessions]);

  useEffect(() => {
    if (
      keyboardEntryRevision === undefined ||
      keyboardEntryRevision <= handledKeyboardEntryRevisionRef.current
    ) {
      return;
    }
    // An entry that arrives before the island renders is handled once it
    // does; it only counts as handled once a column actually takes focus.
    if (pillRef.current === null) return undefined;
    // A sleeping island has nothing to focus, so keyboard mode ends at once.
    if (shownColumns.length === 0) {
      handledKeyboardEntryRevisionRef.current = keyboardEntryRevision;
      onKeyboardExit();
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const cell = cellRefs.current.get(
        keyboardEntryHarness(shownColumns, (column) => openableTargetRef.current(column) !== null),
      );
      if (cell === undefined || !cell.isConnected) return;
      handledKeyboardEntryRevisionRef.current = keyboardEntryRevision;
      cell.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [keyboardEntryRevision, hasSessions, shownColumns, onKeyboardExit]);

  useEffect(() => {
    const pill = pillRef.current;
    if (pill === null) return undefined;
    // A focused column that hides, because its harness went idle, leaves
    // keyboard focus nowhere: move it to the other column, or end keyboard
    // mode once the island sleeps. This listens natively, because React drops
    // the blur a removal fires during its commit; Escape and clicks keep the
    // column mounted, so they never get here.
    let frame = 0;
    const handleFocusOut = (event: globalThis.FocusEvent): void => {
      const cell = event.target;
      if (!(cell instanceof HTMLElement) || !cell.classList.contains('dynamic-island__harness')) {
        return;
      }
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (cell.isConnected || document.activeElement !== document.body) return;
        const remaining = [...cellRefs.current.values()].find((other) => other.isConnected);
        if (remaining === undefined) keyboardExitRef.current();
        else remaining.focus();
      });
    };
    pill.addEventListener('focusout', handleFocusOut);
    return () => {
      window.cancelAnimationFrame(frame);
      pill.removeEventListener('focusout', handleFocusOut);
    };
  }, [hasSessions]);

  useEffect(() => {
    // Keyboard mode ends from anywhere in the focused overlay, not only the pill.
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      onKeyboardExit();
    };
    const clearStaleCapture = (event: globalThis.PointerEvent): void => {
      const pill = pillRef.current;
      if (pill === null || !(event.target instanceof Node) || !pill.contains(event.target)) {
        capturedTargetRef.current = null;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerup', clearStaleCapture);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerup', clearStaleCapture);
    };
  }, [onKeyboardExit]);

  const openableTarget = (column: HarnessColumn): OpenSessionTarget | null => {
    const finished = toneOf(column) === 'finished' ? cued.get(column.provider)?.session : undefined;
    const target = columnTarget(column, finished);
    return target !== null && target.canOpen ? captureOpenTarget(target) : null;
  };
  // The keyboard-entry frame reads the latest rule after this render commits.
  useLayoutEffect(() => {
    openableTargetRef.current = openableTarget;
  });

  if (!hasSessions) return null;

  const handlePointerDown = (
    column: HarnessColumn,
    event: PointerEvent<HTMLButtonElement>,
  ): void => {
    capturedTargetRef.current = event.button === 0 ? openableTarget(column) : null;
  };

  const handleClick = (column: HarnessColumn, event: MouseEvent<HTMLButtonElement>): void => {
    // Keyboard activation (detail 0) opens what the column shows now; a
    // pointer click opens what it showed at pointer-down.
    const clicked = event.detail === 0 ? openableTarget(column) : capturedTargetRef.current;
    capturedTargetRef.current = null;
    if (clicked === null) return;
    void Promise.resolve(onOpenSession(clicked)).catch(() => undefined);
  };

  return (
    <div
      ref={rootRef}
      className={motionReduced ? 'dynamic-island dynamic-island--reduced-motion' : 'dynamic-island'}
      style={
        {
          '--dynamic-island-height': `${ISLAND_HEIGHT}px`,
          '--dynamic-island-padding-x': `${ISLAND_PADDING_X}px`,
          '--dynamic-island-motion': `${ISLAND_MOTION_MS}ms`,
        } as CSSProperties
      }
    >
      <div className="dynamic-island__shape" style={{ width: `${width}px` }}>
        <span className="dynamic-island__shoulder dynamic-island__shoulder--left" />
        <span className="dynamic-island__shoulder dynamic-island__shoulder--right" />
        <div ref={pillRef} className="dynamic-island__pill" role="group" aria-label="Agents">
          <span
            ref={contentRef}
            className="dynamic-island__content"
            data-columns={shownColumns.length}
          >
            {shownColumns.length === 0 && <SleepingSprite />}
            {shownColumns.map((column) => (
              <HarnessCell
                key={column.provider}
                column={column}
                tone={toneOf(column) as ShownTone}
                side={HARNESS_ORDER.indexOf(column.provider) === 0 ? 'start' : 'end'}
                canOpen={openableTarget(column) !== null}
                buttonRef={(cell) => {
                  if (cell === null) cellRefs.current.delete(column.provider);
                  else cellRefs.current.set(column.provider, cell);
                }}
                onPointerDown={(event) => handlePointerDown(column, event)}
                onPointerCancel={() => {
                  capturedTargetRef.current = null;
                }}
                onClick={(event) => handleClick(column, event)}
              />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

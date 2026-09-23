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
} from 'react';
// Latin only: the other subsets are unused and a tiny one would be inlined as a
// data: URL that the overlay's font-src policy blocks.
import '@fontsource/fira-code/latin-500.css';

import type { OverlayHitRegion } from '../../shared/overlay-ipc';
import type { Provider, SessionSnapshot } from '../../shared/session';
import { captureOpenTarget, visibleIslandSessions, type OpenSessionTarget } from './interaction';
import {
  completionSnapshot,
  finishedHarnesses,
  HARNESS_NAME,
  islandTarget,
  summarizeHarnesses,
  type CompletionSnapshot,
  type HarnessColumn,
} from './summary';
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
const ISLAND_PADDING_X = 14;
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

const TONE_WORDS: Record<DotTone, string> = {
  idle: 'idle',
  working: 'working',
  finished: 'finished a turn',
  'needs-input': 'needs input',
};

function HarnessCell({
  column,
  tone,
  side,
}: {
  column: HarnessColumn;
  tone: DotTone;
  side: 'start' | 'end';
}): ReactElement {
  const dot = (
    <span
      // A tone change is a new dot, so it scales in again.
      key={tone}
      className="dynamic-island__dot"
      data-tone={tone}
      style={{ '--dynamic-island-dot': TONE_COLOR[tone] } as CSSProperties}
    />
  );
  const name = <span className="dynamic-island__name">{HARNESS_NAME[column.provider]}</span>;
  // The columns mirror each other around the island's center.
  return (
    <span
      className="dynamic-island__harness"
      data-provider={column.provider}
      data-tone={tone}
      data-side={side}
    >
      {side === 'start' ? dot : name}
      {side === 'start' ? name : dot}
    </span>
  );
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
  const pillRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const capturedTargetRef = useRef<OpenSessionTarget | null>(null);
  const handledKeyboardEntryRevisionRef = useRef(0);
  const [contentWidth, setContentWidth] = useState(0);
  const prefersReducedMotion = usePrefersReducedMotion();
  const motionReduced = prefersReducedMotion || reducedMotion === true;

  const columns = useMemo(() => summarizeHarnesses(sessions), [sessions]);
  const completionsRef = useRef<CompletionSnapshot | null>(null);
  const cueTimersRef = useRef(new Map<Provider, number>());
  const [cued, setCued] = useState<ReadonlySet<Provider>>(() => new Set());
  const hasSessions = visibleIslandSessions(sessions).length > 0;
  const width = Math.max(ISLAND_MIN_WIDTH, Math.ceil(contentWidth) + ISLAND_PADDING_X * 2);

  useEffect(() => {
    const finished = finishedHarnesses(completionsRef.current, sessions);
    completionsRef.current = completionSnapshot(sessions);
    if (finished.size === 0) return;
    onTurnFinished?.();
    // A harness that still works shows green for a moment, then its real tone;
    // one that went idle is simply idle.
    const stillWorking = summarizeHarnesses(sessions).filter(
      (column) => column.tone === 'working' && finished.has(column.provider),
    );
    if (stillWorking.length === 0) return;
    for (const { provider } of stillWorking) {
      window.clearTimeout(cueTimersRef.current.get(provider));
      cueTimersRef.current.set(
        provider,
        window.setTimeout(() => {
          cueTimersRef.current.delete(provider);
          setCued((current) => {
            const next = new Set(current);
            next.delete(provider);
            return next;
          });
        }, FINISHED_CUE_MS),
      );
    }
    setCued((current) => new Set([...current, ...stillWorking.map(({ provider }) => provider)]));
  }, [sessions, onTurnFinished]);

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
    // does; it only counts as handled once the pill actually takes focus.
    if (pillRef.current === null) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const pill = pillRef.current;
      if (pill === null || !pill.isConnected) return;
      handledKeyboardEntryRevisionRef.current = keyboardEntryRevision;
      pill.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [keyboardEntryRevision, hasSessions]);

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

  if (!hasSessions) return null;

  const target = islandTarget(columns);
  // The green cue only replaces working: an idle harness is simply idle again,
  // and a harness waiting for input keeps showing that.
  const toneOf = (column: HarnessColumn): DotTone =>
    column.tone === 'working' && cued.has(column.provider) ? 'finished' : column.tone;
  const openableTarget = (): OpenSessionTarget | null =>
    target !== null && target.canOpen ? captureOpenTarget(target) : null;

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    capturedTargetRef.current = event.button === 0 ? openableTarget() : null;
  };

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    // Keyboard activation (detail 0) opens what the island shows now; a
    // pointer click opens what it showed at pointer-down.
    const clicked = event.detail === 0 ? openableTarget() : capturedTargetRef.current;
    capturedTargetRef.current = null;
    if (clicked === null) return;
    void Promise.resolve(onOpenSession(clicked)).catch(() => undefined);
  };

  const ariaLabel = columns
    .map((column) => `${HARNESS_NAME[column.provider]} ${TONE_WORDS[toneOf(column)]}`)
    .join(', ');

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
        <button
          ref={pillRef}
          className="dynamic-island__pill"
          type="button"
          aria-label={ariaLabel}
          aria-disabled={target === null || !target.canOpen}
          onPointerDown={handlePointerDown}
          onPointerCancel={() => {
            capturedTargetRef.current = null;
          }}
          onClick={handleClick}
        >
          <span ref={contentRef} className="dynamic-island__content">
            {columns.map((column, index) => (
              <HarnessCell
                key={column.provider}
                column={column}
                tone={toneOf(column)}
                side={index === 0 ? 'start' : 'end'}
              />
            ))}
          </span>
        </button>
      </div>
    </div>
  );
}

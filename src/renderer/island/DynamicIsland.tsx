import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import '@fontsource/fira-code/500.css';

import type { SessionSnapshot } from '../../shared/session';
import type { TileHitRegion } from '../tiles/geometry';
import { captureOpenTarget, type OpenSessionTarget } from '../tiles/interaction';
import { TILE_COLORS } from '../tiles/theme';
import { summarizeIsland, type IslandTone } from './summary';
import './island.css';

export interface DynamicIslandProps {
  sessions: readonly SessionSnapshot[];
  onOpenSession: (target: OpenSessionTarget) => void | Promise<unknown>;
  onHitRegionsChange: (regions: readonly TileHitRegion[]) => void;
  onKeyboardExit: () => void;
  /** Monotonic signal from the native menu-bar keyboard-entry action. */
  keyboardEntryRevision?: number;
  reducedMotion?: boolean;
}

const ISLAND_HEIGHT = 32;
const ISLAND_MIN_WIDTH = 48;
const ISLAND_PADDING_X = 14;
const ISLAND_MOTION_MS = 420;
/** Keeps publishing the pill's native hit region until the resize settles. */
const HIT_REGION_SETTLE_MS = ISLAND_MOTION_MS + 80;

const TONE_COLOR: Record<IslandTone, string> = {
  idle: TILE_COLORS.neutral,
  working: TILE_COLORS.blue,
  unread: TILE_COLORS.green,
  'needs-input': TILE_COLORS.orange,
};

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

function IslandLabel({ label }: { label: string }): ReactElement {
  const [provider, ...rest] = label.split(' ');
  return (
    <span className="dynamic-island__label">
      <span className="dynamic-island__provider">{provider}</span> {rest.join(' ')}
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
}: DynamicIslandProps): ReactElement | null {
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const capturedTargetRef = useRef<OpenSessionTarget | null>(null);
  const handledKeyboardEntryRevisionRef = useRef(0);
  const [contentWidth, setContentWidth] = useState(0);
  const prefersReducedMotion = usePrefersReducedMotion();
  const motionReduced = prefersReducedMotion || reducedMotion === true;

  const summary = useMemo(() => summarizeIsland(sessions), [sessions]);
  const hasSessions = sessions.some((session) => session.isTopLevel && !session.isArchived);
  const width = Math.max(ISLAND_MIN_WIDTH, Math.ceil(contentWidth) + ISLAND_PADDING_X * 2);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null) return undefined;
    const update = (): void => setContentWidth(content.scrollWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasSessions]);

  useEffect(() => {
    const root = rootRef.current;
    const pill = pillRef.current;
    if (root === null || pill === null) {
      onHitRegionsChange([]);
      return undefined;
    }
    let frame = 0;
    let lastKey = '';
    const startedAt = performance.now();
    const publish = (): void => {
      const rootBounds = root.getBoundingClientRect();
      const bounds = pill.getBoundingClientRect();
      const region: TileHitRegion = {
        sessionId: summary.target?.id ?? 'island',
        x: bounds.left - rootBounds.left,
        y: bounds.top - rootBounds.top,
        width: bounds.width,
        height: bounds.height,
      };
      const key = JSON.stringify(region);
      if (key !== lastKey) {
        lastKey = key;
        onHitRegionsChange([region]);
      }
      if (performance.now() - startedAt < HIT_REGION_SETTLE_MS) {
        frame = window.requestAnimationFrame(publish);
      }
    };
    publish();
    return () => window.cancelAnimationFrame(frame);
  }, [width, summary.target?.id, onHitRegionsChange, hasSessions]);

  useEffect(() => {
    if (
      keyboardEntryRevision === undefined ||
      keyboardEntryRevision <= handledKeyboardEntryRevisionRef.current
    ) {
      return;
    }
    handledKeyboardEntryRevisionRef.current = keyboardEntryRevision;
    const pill = pillRef.current;
    if (pill !== null) window.requestAnimationFrame(() => pill.focus());
  }, [keyboardEntryRevision, hasSessions]);

  if (!hasSessions) return null;

  const openTarget = (target: OpenSessionTarget | null): void => {
    capturedTargetRef.current = null;
    if (target === null) return;
    void Promise.resolve(onOpenSession(target)).catch(() => undefined);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.currentTarget.blur();
    onKeyboardExit();
  };

  const target = summary.target;
  const ariaLabel = summary.label ?? 'All threads are idle';

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
          data-tone={summary.dots.at(-1)}
          data-session-id={target?.id}
          onPointerDown={() => {
            capturedTargetRef.current = target === null ? null : captureOpenTarget(target);
          }}
          onPointerCancel={() => {
            capturedTargetRef.current = null;
          }}
          onClick={() =>
            openTarget(
              capturedTargetRef.current ?? (target === null ? null : captureOpenTarget(target)),
            )
          }
          onKeyDown={handleKeyDown}
        >
          <span ref={contentRef} className="dynamic-island__content">
            <span className="dynamic-island__dots">
              {summary.dots.map((tone, index) => (
                <span
                  key={`${String(index)}:${tone}`}
                  className="dynamic-island__dot"
                  data-tone={tone}
                  style={{ '--dynamic-island-dot': TONE_COLOR[tone] } as CSSProperties}
                />
              ))}
            </span>
            {summary.label !== null && <IslandLabel key={summary.label} label={summary.label} />}
          </span>
        </button>
      </div>
    </div>
  );
}

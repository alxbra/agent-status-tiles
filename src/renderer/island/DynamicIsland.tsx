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
import type { SessionSnapshot } from '../../shared/session';
import { captureOpenTarget, visibleIslandSessions, type OpenSessionTarget } from './interaction';
import { summarizeIsland } from './summary';
import { TONE_COLOR } from './theme';
import './island.css';

export interface DynamicIslandProps {
  sessions: readonly SessionSnapshot[];
  onOpenSession: (target: OpenSessionTarget) => void | Promise<unknown>;
  onHitRegionsChange: (regions: readonly OverlayHitRegion[]) => void;
  onKeyboardExit: () => void;
  /** Monotonic signal from the native menu-bar keyboard-entry action. */
  keyboardEntryRevision?: number;
  reducedMotion?: boolean;
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
  const hasSessions = visibleIslandSessions(sessions).length > 0;
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

  const target = summary.target;
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
          onPointerDown={handlePointerDown}
          onPointerCancel={() => {
            capturedTargetRef.current = null;
          }}
          onClick={handleClick}
        >
          <span ref={contentRef} className="dynamic-island__content">
            <span className="dynamic-island__dots">
              {summary.dots.map(({ provider, tone }) => (
                <span
                  key={provider ?? 'idle'}
                  className="dynamic-island__dot"
                  data-provider={provider}
                  data-tone={tone}
                  style={{ '--dynamic-island-dot': TONE_COLOR[tone] } as CSSProperties}
                />
              ))}
            </span>
            {summary.label !== null && (
              <span key={summary.label} className="dynamic-island__label">
                {summary.label}
              </span>
            )}
          </span>
        </button>
      </div>
    </div>
  );
}

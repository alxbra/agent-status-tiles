import type { SessionSnapshot } from '../../shared/session';

/** Document-style tabs tucked into the right screen edge. Sizes are CSS px. */
export const TAB_HEIGHT = 28;
export const TAB_GAP = 4;
export const TAB_RADIUS = 8;
export const TAB_PADDING_START = 10;
export const TAB_PADDING_END = 12;
export const TAB_ICON_SIZE = 14;
export const TAB_ICON_GAP = 10;
export const TAB_LABEL_MAX_WIDTH = 220;
/** Folded in: only a colored sliver of each tab stays on screen. */
export const TAB_PEEK_IDLE = 12;
/** Dock hovered: the lab icon and its gutter show; the label starts exactly at the fold. */
export const TAB_PEEK_DOCK = TAB_PADDING_START + TAB_ICON_SIZE + TAB_ICON_GAP;
/** The folded sliver keeps a wider native hit target than its visible width. */
export const TAB_HIT_MIN_WIDTH = 24;
/** Pointer distance from the right edge that pulls every tab out to the icon depth. */
export const DOCK_HOVER_WIDTH = 48;
/** Vertical breathing room around the stack; also hosts the overflow indicators. */
export const DOCK_PADDING = 14;
export const MAX_VISIBLE_TABS = 12;
export const TAB_MOTION_MS = 140;
export const TAB_STAGGER_MS = 8;
export const DEFAULT_STRIP_WIDTH = 360;
export const DEFAULT_STRIP_HEIGHT = 480;

export interface TileHitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  sessionId: string;
}

export interface TabSlot {
  index: number;
  sessionId: string;
  y: number;
  /** Folded-state target: the sliver plus invisible padding toward the desktop. */
  hitRegion: TileHitRegion;
}

export interface TabLayoutOptions {
  width?: number;
  height: number;
  scrollOffset?: number;
  maxVisible?: number;
}

export interface TabLayout {
  slots: readonly TabSlot[];
  hitRegions: readonly TileHitRegion[];
  /** Top of the first slot and bottom of the last slot. */
  top: number;
  bottom: number;
  visibleStart: number;
  visibleCount: number;
  maxStart: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

function emptyLayout(): TabLayout {
  return {
    slots: [],
    hitRegions: [],
    top: 0,
    bottom: 0,
    visibleStart: 0,
    visibleCount: 0,
    maxStart: 0,
    hasPrevious: false,
    hasNext: false,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

export function normalizeStripWidth(width?: number): number {
  return Math.max(TAB_HIT_MIN_WIDTH, finiteOr(width, DEFAULT_STRIP_WIDTH));
}

export function stackHeight(count: number): number {
  const slotCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (slotCount === 0) return 0;
  return slotCount * TAB_HEIGHT + (slotCount - 1) * TAB_GAP;
}

/** Vertical space needed for a slot count, including dock padding for overflow cues. */
export function minimumHeightForSlots(count: number): number {
  const height = stackHeight(count);
  return height === 0 ? 0 : height + DOCK_PADDING * 2;
}

export function visibleSlotCount(height: number, requested = MAX_VISIBLE_TABS): number {
  const usableHeight = Math.max(0, finiteOr(height, DEFAULT_STRIP_HEIGHT)) - DOCK_PADDING * 2;
  const requestedSlots = Math.min(MAX_VISIBLE_TABS, Math.max(0, Math.floor(requested)));
  const fitting = Math.floor((usableHeight + TAB_GAP) / (TAB_HEIGHT + TAB_GAP));
  return clamp(Math.min(requestedSlots, fitting), 0, MAX_VISIBLE_TABS);
}

/** Width of the on-screen part of a tab in each reveal state. */
export function revealedTabWidth(state: 'folded' | 'dock' | 'extended', fullWidth: number): number {
  switch (state) {
    case 'folded':
      return Math.min(TAB_PEEK_IDLE, fullWidth);
    case 'dock':
      return Math.min(TAB_PEEK_DOCK, fullWidth);
    case 'extended':
      return fullWidth;
  }
}

export function layoutTabs(
  sessions: readonly SessionSnapshot[],
  options: TabLayoutOptions,
): TabLayout {
  const height = Math.max(0, finiteOr(options.height, DEFAULT_STRIP_HEIGHT));
  const width = normalizeStripWidth(options.width);
  const visibleCount = Math.min(
    sessions.length,
    visibleSlotCount(height, finiteOr(options.maxVisible, MAX_VISIBLE_TABS)),
  );
  if (visibleCount === 0) return emptyLayout();
  const maxStart = Math.max(0, sessions.length - visibleCount);
  const visibleStart = clamp(Math.round(finiteOr(options.scrollOffset, 0)), 0, maxStart);
  const visibleSessions = sessions.slice(visibleStart, visibleStart + visibleCount);
  const total = stackHeight(visibleSessions.length);
  const top = Math.round((height - total) / 2);

  const slots = visibleSessions.map((session, index): TabSlot => {
    const y = top + index * (TAB_HEIGHT + TAB_GAP);
    return {
      index: visibleStart + index,
      sessionId: session.id,
      y,
      hitRegion: {
        x: width - TAB_HIT_MIN_WIDTH,
        y,
        width: TAB_HIT_MIN_WIDTH,
        height: TAB_HEIGHT,
        sessionId: session.id,
      },
    };
  });

  return {
    slots,
    hitRegions: slots.map((slot) => slot.hitRegion),
    top,
    bottom: top + total,
    visibleStart,
    visibleCount,
    maxStart,
    hasPrevious: visibleStart > 0,
    hasNext: visibleStart < maxStart,
  };
}

export function sessionHitRegions(
  sessions: readonly SessionSnapshot[],
  height = DEFAULT_STRIP_HEIGHT,
  width = DEFAULT_STRIP_WIDTH,
): readonly TileHitRegion[] {
  return layoutTabs(sessions, { height, width }).hitRegions;
}

/**
 * Converts a rendered tab rectangle (root-local, possibly translated past the
 * right edge) into its native hit target: clipped to the strip and never
 * narrower than the folded minimum so the sliver stays easy to reach.
 */
export function tabHitRegion(
  rendered: { left: number; top: number; width: number; height: number },
  stripWidth: number,
  sessionId: string,
): TileHitRegion | null {
  const width = normalizeStripWidth(stripWidth);
  if (
    !Number.isFinite(rendered.left) ||
    !Number.isFinite(rendered.top) ||
    !Number.isFinite(rendered.width) ||
    !Number.isFinite(rendered.height) ||
    rendered.height <= 0
  ) {
    return null;
  }
  const right = Math.min(width, rendered.left + rendered.width);
  const left = Math.max(0, Math.min(rendered.left, right - TAB_HIT_MIN_WIDTH));
  if (right <= left) return null;
  return {
    x: left,
    y: rendered.top,
    width: right - left,
    height: rendered.height,
    sessionId,
  };
}

export interface HoverPoint {
  /** Root-local coordinates. */
  x: number;
  y: number;
}

export interface HoverResolution {
  /** The pointer is somewhere that keeps the dock revealed. */
  inside: boolean;
  /**
   * Local slot index the pointer's row selects while a tab is extended; null
   * in the padding rows. Always null before a tab is extended, when the caller
   * decides by the tab element under the pointer instead.
   */
  hoveredIndex: number | null;
}

export interface HoverOptions {
  stripWidth: number;
  /** A tab is currently extended by the pointer, so the reach zone applies. */
  extended: boolean;
  /** Horizontal depth of the reach zone; see `reachWidthFor`. */
  reachWidth: number;
}

/** The reach zone stretches as far left as the widest rendered tab. */
export function reachWidthFor(tabWidths: readonly number[], stripWidth: number): number {
  const widest = tabWidths.reduce(
    (maximum, width) => (Number.isFinite(width) && width > maximum ? width : maximum),
    DOCK_HOVER_WIDTH,
  );
  return Math.min(normalizeStripWidth(stripWidth), widest);
}

/** Rows own half of each gap so vertical travel never falls between tabs. */
export function slotIndexAtY(layout: TabLayout, y: number): number | null {
  const first = layout.slots[0];
  if (first === undefined || !Number.isFinite(y)) return null;
  const start = first.y - TAB_GAP / 2;
  const end = layout.bottom + TAB_GAP / 2;
  if (y < start || y >= end) return null;
  const pitch = TAB_HEIGHT + TAB_GAP;
  return clamp(Math.floor((y - start) / pitch), 0, layout.slots.length - 1);
}

export function resolveHover(
  layout: TabLayout,
  point: HoverPoint,
  options: HoverOptions,
): HoverResolution {
  if (layout.slots.length === 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { inside: false, hoveredIndex: null };
  }
  const width = normalizeStripWidth(options.stripWidth);
  const depth = options.extended
    ? Math.min(width, Math.max(DOCK_HOVER_WIDTH, finiteOr(options.reachWidth, DOCK_HOVER_WIDTH)))
    : DOCK_HOVER_WIDTH;
  const inside =
    point.x >= width - depth &&
    point.x <= width &&
    point.y >= layout.top - DOCK_PADDING &&
    point.y <= layout.bottom + DOCK_PADDING;
  if (!inside) return { inside: false, hoveredIndex: null };
  return { inside: true, hoveredIndex: options.extended ? slotIndexAtY(layout, point.y) : null };
}

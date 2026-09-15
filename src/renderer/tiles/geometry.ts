import type { SessionSnapshot } from '../../shared/session';

export const TILE_SIZE = 10;
export const TILE_RADIUS = 3;
export const EXPANDED_TILE_SIZE = 40;
export const EXPANDED_TILE_RADIUS = 8;
export const SLOT_SPACING = 24;
export const RIGHT_EDGE_INSET = 12;
export const TILE_HIT_SIZE = 24;
export const MIN_SURFACE_GAP = 6;
export const MAGNIFICATION_RADIUS_SLOTS = 2;
export const MAX_VISIBLE_TILES = 12;
export const DEFAULT_STRIP_WIDTH = 88;
export const DEFAULT_STRIP_HEIGHT = 480;

export interface TilePoint {
  x: number;
  y: number;
}

export interface TileHitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  sessionId: string;
}

export interface TileGeometry {
  index: number;
  sessionId: string;
  centerY: number;
  size: number;
  radius: number;
  x: number;
  y: number;
  influence: number;
  expanded: boolean;
  hitRegion: TileHitRegion;
}

export interface TileLayoutOptions {
  width?: number;
  height: number;
  pointer?: TilePoint | null;
  scrollOffset?: number;
  maxVisible?: number;
}

export interface TileLayout {
  tiles: readonly TileGeometry[];
  hitRegions: readonly TileHitRegion[];
  visibleStart: number;
  visibleCount: number;
  maxStart: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

function emptyLayout(): TileLayout {
  return {
    tiles: [],
    hitRegions: [],
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

/** Smoothstep falloff keeps adjacent tiles calm while retaining a two-slot influence radius. */
export function magnificationInfluence(pointerY: number | undefined, slotCenterY: number): number {
  if (pointerY === undefined || !Number.isFinite(pointerY)) return 0;

  const normalizedDistance = Math.abs(pointerY - slotCenterY) / SLOT_SPACING;
  const progress = clamp(1 - normalizedDistance / MAGNIFICATION_RADIUS_SLOTS, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

export function tileSizeForInfluence(influence: number): number {
  return TILE_SIZE + (EXPANDED_TILE_SIZE - TILE_SIZE) * clamp(influence, 0, 1);
}

export function tileRadiusForInfluence(influence: number): number {
  return TILE_RADIUS + (EXPANDED_TILE_RADIUS - TILE_RADIUS) * clamp(influence, 0, 1);
}

function packUnboundedCenters(
  desiredCenters: readonly number[],
  sizes: readonly number[],
): readonly number[] {
  if (desiredCenters.length === 0) return [];
  const centers = [...desiredCenters];
  for (let index = 1; index < centers.length; index += 1) {
    const minimum = centers[index - 1] + (sizes[index - 1] + sizes[index]) / 2 + MIN_SURFACE_GAP;
    centers[index] = Math.max(centers[index], minimum);
  }
  for (let index = centers.length - 2; index >= 0; index -= 1) {
    const maximum = centers[index + 1] - (sizes[index] + sizes[index + 1]) / 2 - MIN_SURFACE_GAP;
    centers[index] = Math.min(centers[index], maximum);
  }
  return centers;
}

/**
 * Returns the vertical space needed for a given number of slots, including
 * 24px hit targets and the worst two-slot magnification neighborhood. This
 * prevents a short work area from producing clipped expanded surfaces.
 */
export function minimumHeightForSlots(count: number): number {
  const slotCount = Math.max(0, Math.floor(count));
  if (slotCount === 0) return 0;

  const centers = Array.from({ length: slotCount }, (_, index) => index * SLOT_SPACING);
  const samplePoints = new Set<number>();
  const firstCenter = centers[0];
  const lastCenter = centers.at(-1)!;
  for (let point = firstCenter - SLOT_SPACING; point <= lastCenter + SLOT_SPACING; point += 1) {
    samplePoints.add(point);
  }
  centers.forEach((center) => {
    samplePoints.add(center);
    samplePoints.add(center + SLOT_SPACING / 2);
  });

  let required = (slotCount - 1) * SLOT_SPACING + TILE_HIT_SIZE;
  for (const pointerY of samplePoints) {
    const sizes = centers.map((center) =>
      tileSizeForInfluence(magnificationInfluence(pointerY, center)),
    );
    const packedCenters = packUnboundedCenters(centers, sizes);
    const top = Math.min(
      ...packedCenters.map((center, index) => center - Math.max(TILE_HIT_SIZE, sizes[index]) / 2),
    );
    const bottom = Math.max(
      ...packedCenters.map((center, index) => center + Math.max(TILE_HIT_SIZE, sizes[index]) / 2),
    );
    required = Math.max(required, bottom - top);
  }
  return required;
}

export function visibleSlotCount(height: number, requested = MAX_VISIBLE_TILES): number {
  const usableHeight = Math.max(0, finiteOr(height, DEFAULT_STRIP_HEIGHT));
  const requestedSlots = Math.min(MAX_VISIBLE_TILES, Math.max(0, Math.floor(requested)));
  for (let count = requestedSlots; count >= 1; count -= 1) {
    if (minimumHeightForSlots(count) <= usableHeight) return count;
  }
  return 0;
}

function unmagnifiedCenters(height: number, count: number): readonly number[] {
  const center = finiteOr(height, DEFAULT_STRIP_HEIGHT) / 2;
  const first = center - ((count - 1) * SLOT_SPACING) / 2;
  return Array.from({ length: count }, (_, index) => first + index * SLOT_SPACING);
}

/**
 * Magnification is calculated from these stable slot coordinates. Packing only
 * keeps visible surfaces apart; it never feeds the resulting positions back
 * into the pointer calculation, avoiding hover oscillation.
 */
function packCenters(
  desiredCenters: readonly number[],
  sizes: readonly number[],
  height: number,
): readonly number[] {
  if (desiredCenters.length === 0) return [];

  const centers = [...desiredCenters];
  for (let index = 1; index < centers.length; index += 1) {
    const minimum = centers[index - 1] + (sizes[index - 1] + sizes[index]) / 2 + MIN_SURFACE_GAP;
    centers[index] = Math.max(centers[index], minimum);
  }
  for (let index = centers.length - 2; index >= 0; index -= 1) {
    const maximum = centers[index + 1] - (sizes[index] + sizes[index + 1]) / 2 - MIN_SURFACE_GAP;
    centers[index] = Math.min(centers[index], maximum);
  }

  const top = centers[0] - Math.max(TILE_HIT_SIZE, sizes[0]) / 2;
  const bottom = centers.at(-1)! + Math.max(TILE_HIT_SIZE, sizes.at(-1)!) / 2;
  const minimumShift = -top;
  const maximumShift = height - bottom;
  const shift =
    minimumShift <= maximumShift
      ? clamp(0, minimumShift, maximumShift)
      : (minimumShift + maximumShift) / 2;

  return centers.map((center) => center + shift);
}

function hitRegionForTile(
  tile: Pick<TileGeometry, 'x' | 'y' | 'size' | 'centerY' | 'sessionId'>,
): TileHitRegion {
  const hitSize = Math.max(TILE_HIT_SIZE, tile.size);
  return {
    x: tile.x + tile.size / 2 - hitSize / 2,
    y: tile.centerY - hitSize / 2,
    width: hitSize,
    height: hitSize,
    sessionId: tile.sessionId,
  };
}

export function layoutTiles(
  sessions: readonly SessionSnapshot[],
  options: TileLayoutOptions,
): TileLayout {
  const height = Math.max(0, finiteOr(options.height, DEFAULT_STRIP_HEIGHT));
  const width = Math.max(DEFAULT_STRIP_WIDTH, finiteOr(options.width, DEFAULT_STRIP_WIDTH));
  const visibleCount = Math.min(
    sessions.length,
    visibleSlotCount(height, finiteOr(options.maxVisible, MAX_VISIBLE_TILES)),
  );
  if (visibleCount === 0) return emptyLayout();
  const maxStart = Math.max(0, sessions.length - visibleCount);
  const visibleStart = clamp(Math.round(finiteOr(options.scrollOffset, 0)), 0, maxStart);
  const visibleSessions = sessions.slice(visibleStart, visibleStart + visibleCount);
  const stableCenters = unmagnifiedCenters(height, visibleSessions.length);
  const pointerY = options.pointer?.y;
  const influences = stableCenters.map((center) => magnificationInfluence(pointerY, center));
  const sizes = influences.map(tileSizeForInfluence);
  const centers = packCenters(stableCenters, sizes, height);

  const tiles = visibleSessions.map((session, index) => {
    const size = sizes[index];
    const influence = influences[index];
    const centerY = centers[index];
    const x = width - RIGHT_EDGE_INSET - size;
    const tile: TileGeometry = {
      index: visibleStart + index,
      sessionId: session.id,
      centerY,
      size,
      radius: tileRadiusForInfluence(influence),
      x,
      y: centerY - size / 2,
      influence,
      expanded: influence > 0,
      hitRegion: {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        sessionId: session.id,
      },
    };
    tile.hitRegion = hitRegionForTile(tile);
    return tile;
  });

  return {
    tiles,
    hitRegions: tiles.map((tile) => tile.hitRegion),
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
): readonly TileHitRegion[] {
  return layoutTiles(sessions, { height }).hitRegions;
}

export function surfacesHaveMinimumGap(tiles: readonly TileGeometry[]): boolean {
  const sorted = [...tiles].sort((left, right) => left.centerY - right.centerY);
  return sorted.every((tile, index) => {
    const previous = sorted[index - 1];
    return (
      previous === undefined || tile.y >= previous.y + previous.size + MIN_SURFACE_GAP - 0.0001
    );
  });
}

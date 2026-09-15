import { MAX_OVERLAY_HIT_REGIONS, type OverlayHitRegion } from '../shared/overlay-ipc';
import type { TileHitRegion } from './tiles/geometry';

export interface OverlayViewport {
  width: number;
  height: number;
}

export interface OverlayRootBounds {
  left: number;
  top: number;
}

export interface OverlayPortalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clipRectangle(
  rectangle: OverlayPortalRect,
  viewport: OverlayViewport,
): OverlayHitRegion | null {
  if (
    !Number.isFinite(rectangle.x) ||
    !Number.isFinite(rectangle.y) ||
    !finitePositive(rectangle.width) ||
    !finitePositive(rectangle.height)
  ) {
    return null;
  }

  const left = Math.max(0, rectangle.x);
  const top = Math.max(0, rectangle.y);
  const right = Math.min(viewport.width, rectangle.x + rectangle.width);
  const bottom = Math.min(viewport.height, rectangle.y + rectangle.height);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom)
  ) {
    return null;
  }
  if (right <= left || bottom <= top) return null;

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function regionKey(region: OverlayHitRegion): string {
  return `${region.x}:${region.y}:${region.width}:${region.height}`;
}

/**
 * Converts the tile renderer's root-local coordinates and portal viewport
 * rectangles into native overlay viewport coordinates. Tiles are inserted
 * first so the bounded region cap never drops a tile for an extra portal.
 */
export function translateAndClipHitRegions(
  tileRegions: readonly TileHitRegion[],
  rootBounds: OverlayRootBounds | null,
  portalRects: readonly OverlayPortalRect[],
  viewport: OverlayViewport,
  maxRegions = MAX_OVERLAY_HIT_REGIONS,
): readonly OverlayHitRegion[] {
  if (!finitePositive(viewport.width) || !finitePositive(viewport.height)) return [];

  const cap = Number.isSafeInteger(maxRegions) && maxRegions > 0 ? maxRegions : 0;
  if (cap === 0) return [];

  const rectangles: OverlayPortalRect[] = [];
  if (rootBounds && Number.isFinite(rootBounds.left) && Number.isFinite(rootBounds.top)) {
    for (const tile of tileRegions) {
      rectangles.push({
        x: rootBounds.left + tile.x,
        y: rootBounds.top + tile.y,
        width: tile.width,
        height: tile.height,
      });
    }
  }
  rectangles.push(...portalRects);

  const regions: OverlayHitRegion[] = [];
  const seen = new Set<string>();
  for (const rectangle of rectangles) {
    const clipped = clipRectangle(rectangle, viewport);
    if (clipped === null) continue;
    const key = regionKey(clipped);
    if (seen.has(key)) continue;
    seen.add(key);
    regions.push(clipped);
    if (regions.length === cap) break;
  }
  return regions;
}

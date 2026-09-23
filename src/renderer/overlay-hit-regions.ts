import { MAX_OVERLAY_HIT_REGIONS, type OverlayHitRegion } from '../shared/overlay-ipc';

export interface OverlayViewport {
  width: number;
  height: number;
}

export interface OverlayRootBounds {
  left: number;
  top: number;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clipRectangle(
  rectangle: OverlayHitRegion,
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
 * Converts the island's root-local hit regions into native overlay viewport
 * coordinates, clipped to the viewport, deduplicated, and bounded by the cap.
 */
export function translateAndClipHitRegions(
  regions: readonly OverlayHitRegion[],
  rootBounds: OverlayRootBounds | null,
  viewport: OverlayViewport,
  maxRegions = MAX_OVERLAY_HIT_REGIONS,
): readonly OverlayHitRegion[] {
  if (!finitePositive(viewport.width) || !finitePositive(viewport.height)) return [];
  if (rootBounds === null || !Number.isFinite(rootBounds.left) || !Number.isFinite(rootBounds.top))
    return [];

  const cap = Number.isSafeInteger(maxRegions) && maxRegions > 0 ? maxRegions : 0;
  if (cap === 0) return [];

  const translated: OverlayHitRegion[] = [];
  const seen = new Set<string>();
  for (const region of regions) {
    const clipped = clipRectangle(
      {
        x: rootBounds.left + region.x,
        y: rootBounds.top + region.y,
        width: region.width,
        height: region.height,
      },
      viewport,
    );
    if (clipped === null) continue;
    const key = regionKey(clipped);
    if (seen.has(key)) continue;
    seen.add(key);
    translated.push(clipped);
    if (translated.length === cap) break;
  }
  return translated;
}

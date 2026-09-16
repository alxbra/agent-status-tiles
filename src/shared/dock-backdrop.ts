/** Shared geometry for the decorative, non-interactive dock material. */
export const DOCK_BACKDROP_PADDING = 8;
export const EXPANDED_TILE_SIZE = 40;
export const RIGHT_EDGE_INSET = 12;
export const DEFAULT_STRIP_WIDTH = 88;
export const DEFAULT_STRIP_HEIGHT = 480;

export interface DockBackdropBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BackdropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function dockBackdropBounds(
  regions: readonly BackdropRegion[],
  stripWidth: number,
  stripHeight: number,
): DockBackdropBounds | null {
  if (regions.length === 0) return null;
  const width = Math.max(
    DEFAULT_STRIP_WIDTH,
    Number.isFinite(stripWidth) ? stripWidth : DEFAULT_STRIP_WIDTH,
  );
  const height = Math.max(0, Number.isFinite(stripHeight) ? stripHeight : DEFAULT_STRIP_HEIGHT);
  const y = clamp(
    Math.min(...regions.map((region) => region.y)) - DOCK_BACKDROP_PADDING,
    0,
    height,
  );
  const bottom = clamp(
    Math.max(...regions.map((region) => region.y + region.height)) + DOCK_BACKDROP_PADDING,
    y,
    height,
  );
  return {
    x: width - RIGHT_EDGE_INSET - EXPANDED_TILE_SIZE - DOCK_BACKDROP_PADDING,
    y,
    width: EXPANDED_TILE_SIZE + DOCK_BACKDROP_PADDING * 2,
    height: bottom - y,
  };
}

import { describe, expect, it } from 'vitest';

import type { SessionSnapshot } from '../../src/shared/session';
import {
  DEFAULT_STRIP_WIDTH,
  dockBackdropBounds,
  layoutTiles,
  minimumHeightForSlots,
  normalizeStripWidth,
  surfacesHaveMinimumGap,
  TILE_HIT_SIZE,
  TILE_RADIUS,
  TILE_SIZE,
  visibleSlotCount,
} from '../../src/renderer/tiles';

function session(id: string): SessionSnapshot {
  return {
    id,
    provider: 'codex',
    surface: 'desktop',
    title: id,
    status: 'working',
    updatedAt: 1,
    lastTurnStartedAt: 1,
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
  };
}

function sessions(count: number): readonly SessionSnapshot[] {
  return Array.from({ length: count }, (_, index) => session(`codex:session-${index}`));
}

function expectRegionsInside(layout: ReturnType<typeof layoutTiles>, height: number): void {
  for (const region of layout.hitRegions) {
    expect(region.x).toBeGreaterThanOrEqual(0);
    expect(region.y).toBeGreaterThanOrEqual(0);
    expect(region.x + region.width).toBeLessThanOrEqual(DEFAULT_STRIP_WIDTH);
    expect(region.y + region.height).toBeLessThanOrEqual(height);
  }
}

function expectHitRegionsDoNotOverlap(layout: ReturnType<typeof layoutTiles>): void {
  const regions = [...layout.hitRegions].sort((left, right) => left.y - right.y);
  for (let index = 1; index < regions.length; index += 1) {
    expect(regions[index]!.y).toBeGreaterThanOrEqual(
      regions[index - 1]!.y + regions[index - 1]!.height,
    );
  }
}

describe('status tile geometry', () => {
  it('normalizes narrow and non-finite strip widths once at the minimum', () => {
    expect(normalizeStripWidth(72)).toBe(DEFAULT_STRIP_WIDTH);
    expect(normalizeStripWidth(Number.NaN)).toBe(DEFAULT_STRIP_WIDTH);
    expect(normalizeStripWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_STRIP_WIDTH);
    expect(normalizeStripWidth(120)).toBe(120);
  });

  it('keeps collapsed tiles square, colored-only, and anchored to the right edge', () => {
    const layout = layoutTiles(sessions(1), { width: DEFAULT_STRIP_WIDTH, height: 480 });
    const tile = layout.tiles[0]!;

    expect(tile.size).toBe(TILE_SIZE);
    expect(tile.radius).toBe(TILE_RADIUS);
    expect(tile.x + tile.size).toBe(DEFAULT_STRIP_WIDTH - 12);
    expect(tile.hitRegion.width).toBe(TILE_HIT_SIZE);
    expect(tile.hitRegion.height).toBe(TILE_HIT_SIZE);
    expectRegionsInside(layout, 480);
  });

  it('bounds the decorative dock behind visible targets without changing their hit regions', () => {
    const empty = layoutTiles([], { height: 480 });
    expect(dockBackdropBounds(empty.tiles, DEFAULT_STRIP_WIDTH, 480)).toBeNull();

    const collapsed = layoutTiles(sessions(1), { height: 480 });
    const originalHitRegions = collapsed.hitRegions.map((region) => ({ ...region }));
    const collapsedBackdrop = dockBackdropBounds(collapsed.tiles, DEFAULT_STRIP_WIDTH, 480);
    expect(collapsedBackdrop).toEqual({ x: 28, y: 220, width: 56, height: 40 });
    expect(collapsed.hitRegions).toEqual(originalHitRegions);

    const expanded = layoutTiles(sessions(1), {
      height: 480,
      pointer: { x: DEFAULT_STRIP_WIDTH - 1, y: 240 },
    });
    expect(dockBackdropBounds(expanded.tiles, DEFAULT_STRIP_WIDTH, 480)).toEqual({
      x: 28,
      y: 212,
      width: 56,
      height: 56,
    });
    expect(expanded.hitRegions[0]).toMatchObject({ width: 40, height: 40 });
  });

  it('keeps the dock backdrop inside a short work area while covering every target', () => {
    const height = minimumHeightForSlots(5);
    for (let pointerY = 0; pointerY <= Math.ceil(height); pointerY += 1) {
      const layout = layoutTiles(sessions(5), {
        height,
        pointer: { x: DEFAULT_STRIP_WIDTH - 1, y: pointerY },
      });
      const backdrop = dockBackdropBounds(layout.tiles, DEFAULT_STRIP_WIDTH, height)!;
      expect(backdrop.x).toBeGreaterThanOrEqual(0);
      expect(backdrop.x + backdrop.width).toBeLessThanOrEqual(DEFAULT_STRIP_WIDTH);
      expect(backdrop.y).toBeGreaterThanOrEqual(0);
      expect(backdrop.y + backdrop.height).toBeLessThanOrEqual(height);
      for (const target of layout.hitRegions) {
        expect(target.x).toBeGreaterThanOrEqual(backdrop.x);
        expect(target.x + target.width).toBeLessThanOrEqual(backdrop.x + backdrop.width);
        expect(target.y).toBeGreaterThanOrEqual(backdrop.y);
        expect(target.y + target.height).toBeLessThanOrEqual(backdrop.y + backdrop.height);
      }
    }
  });

  it('reaches 40px at the stable hovered slot and keeps surfaces separated', () => {
    const layout = layoutTiles(sessions(5), {
      height: 480,
      pointer: { x: DEFAULT_STRIP_WIDTH - 1, y: 240 },
    });
    const hovered = layout.tiles[2]!;

    expect(hovered.size).toBe(40);
    expect(hovered.radius).toBe(8);
    expect(hovered.x + hovered.size).toBe(DEFAULT_STRIP_WIDTH - 12);
    expect(hovered.hitRegion.width).toBe(40);
    expect(hovered.hitRegion.height).toBe(40);
    expect(surfacesHaveMinimumGap(layout.tiles)).toBe(true);
    expectHitRegionsDoNotOverlap(layout);
  });

  it('reserves enough room for top and bottom hover at short heights', () => {
    const height = minimumHeightForSlots(5);
    expect(visibleSlotCount(height, 5)).toBe(5);

    const firstCenter = height / 2 - 2 * 24;
    const topHover = layoutTiles(sessions(5), {
      height,
      pointer: { x: DEFAULT_STRIP_WIDTH - 1, y: firstCenter },
    });
    const bottomHover = layoutTiles(sessions(5), {
      height,
      pointer: { x: DEFAULT_STRIP_WIDTH - 1, y: height - firstCenter },
    });

    expectRegionsInside(topHover, height);
    expectRegionsInside(bottomHover, height);
    expect(surfacesHaveMinimumGap(topHover.tiles)).toBe(true);
    expect(surfacesHaveMinimumGap(bottomHover.tiles)).toBe(true);
  });

  it('returns no tile when even one bounded hit target cannot fit', () => {
    const minimum = minimumHeightForSlots(1);
    expect(minimum).toBeGreaterThanOrEqual(TILE_HIT_SIZE);
    expect(visibleSlotCount(minimum - 0.1, 1)).toBe(0);
    expect(layoutTiles(sessions(1), { height: minimum - 0.1 }).tiles).toHaveLength(0);
  });

  it('keeps every hit target bounded through the full short-height pointer sweep', () => {
    const height = minimumHeightForSlots(5);
    for (let pointerY = 0; pointerY <= Math.ceil(height); pointerY += 1) {
      const layout = layoutTiles(sessions(5), {
        height,
        pointer: { x: DEFAULT_STRIP_WIDTH - 1, y: pointerY },
      });
      expectRegionsInside(layout, height);
    }
  });

  it('limits visible slots to twelve and exposes directional overflow state', () => {
    const layout = layoutTiles(sessions(30), { height: 480, scrollOffset: 7 });

    expect(layout.tiles).toHaveLength(12);
    expect(layout.visibleStart).toBe(7);
    expect(layout.hasPrevious).toBe(true);
    expect(layout.hasNext).toBe(true);
    expect(layout.tiles[0]?.index).toBe(7);
    expect(layout.tiles.at(-1)?.index).toBe(18);
    expectRegionsInside(layout, 480);
  });
});

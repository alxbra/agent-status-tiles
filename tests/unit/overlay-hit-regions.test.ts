import { describe, expect, it } from 'vitest';

import {
  translateAndClipHitRegions,
  type OverlayPortalRect,
} from '../../src/renderer/overlay-hit-regions';
import type { TileHitRegion } from '../../src/renderer/tiles/geometry';

function tile(x: number, y: number, width = 24, height = 24): TileHitRegion {
  return { x, y, width, height, sessionId: `codex:test-${String(x)}-${String(y)}` };
}

function portal(x: number, y: number, width: number, height: number): OverlayPortalRect {
  return { x, y, width, height };
}

describe('overlay hit-region translation', () => {
  it('translates root-local tile targets and keeps portal targets in viewport coordinates', () => {
    expect(
      translateAndClipHitRegions([tile(0, 100)], { left: 272, top: 0 }, [portal(10, 20, 80, 30)], {
        width: 360,
        height: 480,
      }),
    ).toEqual([
      { x: 272, y: 100, width: 24, height: 24 },
      { x: 10, y: 20, width: 80, height: 30 },
    ]);
  });

  it('clips partially visible rectangles and drops invalid or fully outside rectangles', () => {
    expect(
      translateAndClipHitRegions(
        [tile(-10, 470, 30, 30)],
        { left: 0, top: 0 },
        [
          portal(-10, 20, 30, 30),
          portal(350, 470, 30, 30),
          portal(361, 20, 10, 10),
          portal(0, 0, Number.NaN, 10),
          portal(0, 0, 10, -1),
        ],
        { width: 360, height: 480 },
      ),
    ).toEqual([
      { x: 0, y: 470, width: 20, height: 10 },
      { x: 0, y: 20, width: 20, height: 30 },
      { x: 350, y: 470, width: 10, height: 10 },
    ]);
  });

  it('deduplicates geometry and preserves tile priority at the shared cap', () => {
    const regions = translateAndClipHitRegions(
      Array.from({ length: 12 }, (_, index) => tile(200, index * 24)),
      { left: 0, top: 0 },
      [portal(200, 0, 24, 24), portal(20, 20, 50, 20), portal(80, 20, 50, 20)],
      { width: 360, height: 480 },
    );

    expect(regions).toHaveLength(14);
    expect(regions.slice(0, 12)).toEqual(
      Array.from({ length: 12 }, (_, index) => ({ x: 200, y: index * 24, width: 24, height: 24 })),
    );
    expect(regions.slice(12)).toEqual([
      { x: 20, y: 20, width: 50, height: 20 },
      { x: 80, y: 20, width: 50, height: 20 },
    ]);
  });

  it('returns no regions for an invalid viewport or cap', () => {
    expect(
      translateAndClipHitRegions([tile(1, 1)], { left: 0, top: 0 }, [], {
        width: Number.NaN,
        height: 480,
      }),
    ).toEqual([]);
    expect(
      translateAndClipHitRegions(
        [tile(1, 1)],
        { left: 0, top: 0 },
        [],
        { width: 100, height: 100 },
        0,
      ),
    ).toEqual([]);
  });
});

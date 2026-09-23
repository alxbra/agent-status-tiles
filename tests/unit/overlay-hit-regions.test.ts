import { describe, expect, it } from 'vitest';

import type { OverlayHitRegion } from '../../src/shared/overlay-ipc';
import { translateAndClipHitRegions } from '../../src/renderer/overlay-hit-regions';

function region(x: number, y: number, width = 24, height = 24): OverlayHitRegion {
  return { x, y, width, height };
}

describe('overlay hit-region translation', () => {
  it('translates root-local island regions into viewport coordinates', () => {
    expect(
      translateAndClipHitRegions(
        [region(100, 0, 160, 32)],
        { left: 4, top: 2 },
        {
          width: 360,
          height: 56,
        },
      ),
    ).toEqual([{ x: 104, y: 2, width: 160, height: 32 }]);
  });

  it('clips partially visible rectangles and drops invalid or fully outside rectangles', () => {
    expect(
      translateAndClipHitRegions(
        [
          region(-10, 40, 30, 30),
          region(350, 0, 30, 30),
          region(361, 20, 10, 10),
          region(0, 0, Number.NaN, 10),
          region(0, 0, 10, -1),
        ],
        { left: 0, top: 0 },
        { width: 360, height: 56 },
      ),
    ).toEqual([
      { x: 0, y: 40, width: 20, height: 16 },
      { x: 350, y: 0, width: 10, height: 30 },
    ]);
  });

  it('deduplicates geometry and stops at the cap', () => {
    const regions = translateAndClipHitRegions(
      [region(0, 0), region(0, 0), region(30, 0), region(60, 0)],
      { left: 0, top: 0 },
      { width: 360, height: 56 },
      2,
    );
    expect(regions).toEqual([region(0, 0), region(30, 0)]);
  });

  it('returns no regions for an invalid viewport, root, or cap', () => {
    expect(
      translateAndClipHitRegions(
        [region(1, 1)],
        { left: 0, top: 0 },
        {
          width: Number.NaN,
          height: 56,
        },
      ),
    ).toEqual([]);
    expect(translateAndClipHitRegions([region(1, 1)], null, { width: 100, height: 100 })).toEqual(
      [],
    );
    expect(
      translateAndClipHitRegions(
        [region(1, 1)],
        { left: 0, top: 0 },
        { width: 100, height: 100 },
        0,
      ),
    ).toEqual([]);
  });
});

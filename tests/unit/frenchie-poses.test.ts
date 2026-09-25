import { describe, expect, it } from 'vitest';

import {
  FRENCHIE_COLORS,
  pickSleepingPose,
  SLEEPING_POSES,
} from '../../src/renderer/island/frenchie-poses';

const STATUS_COLORS = ['#8FEA98', '#8DCEF5', '#FF8A3D', '#FF6B73'];

describe('sleeping frenchie poses', () => {
  it('offers five distinct poses on the 12-row grid, each with a real twitch', () => {
    expect(SLEEPING_POSES.map(({ name }) => name)).toEqual([
      'head-on-paws',
      'curled-up',
      'belly-up',
      'donut-bed',
      'sploot',
    ]);
    for (const { name, frame, twitch } of SLEEPING_POSES) {
      const width = frame[0]!.length;
      expect(frame, name).toHaveLength(12);
      expect(twitch, name).toHaveLength(12);
      for (const row of [...frame, ...twitch]) {
        expect(row, name).toHaveLength(width);
        expect(row, name).toMatch(/^[.KkFfWGENRrP]+$/u);
      }
      expect(twitch, name).not.toEqual(frame);
    }
  });

  it('never borrows a status color', () => {
    const colors = Object.values(FRENCHIE_COLORS).map((color) => color.toUpperCase());
    for (const status of STATUS_COLORS) expect(colors).not.toContain(status);
  });

  it('picks any pose first and never the same pose twice in a row', () => {
    const count = SLEEPING_POSES.length;
    const first = new Set(
      Array.from({ length: count }, (_, step) => pickSleepingPose(undefined, () => step / count)),
    );
    expect([...first].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(pickSleepingPose(undefined, () => 0.999_999)).toBe(count - 1);
    for (let previous = 0; previous < count; previous += 1) {
      const next = new Set(
        Array.from({ length: count - 1 }, (_, step) =>
          pickSleepingPose(previous, () => step / (count - 1)),
        ),
      );
      expect(next.has(previous)).toBe(false);
      expect(next.size).toBe(count - 1);
      expect(pickSleepingPose(previous, () => 0.999_999)).not.toBe(previous);
    }
  });
});

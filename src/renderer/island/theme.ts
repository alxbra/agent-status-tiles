import type { HarnessTone } from './summary';

/** What a dot shows: the harness tone, or the brief green cue after a turn finished. */
export type DotTone = HarnessTone | 'finished';

/**
 * The status colors are shared with codex-status-actions
 * (Apache-2.0, https://github.com/alxbra/codex-status-actions).
 */
const ISLAND_COLORS = {
  neutral: '#F1F1ED',
  green: '#8FEA98',
  blue: '#8DCEF5',
  orange: '#FF8A3D',
} as const;

export const TONE_COLOR: Record<DotTone, string> = {
  idle: ISLAND_COLORS.neutral,
  working: ISLAND_COLORS.blue,
  finished: ISLAND_COLORS.green,
  'needs-input': ISLAND_COLORS.orange,
};

/** How long a harness shows the green cue after one of its turns finished. */
export const FINISHED_CUE_MS = 10_000;

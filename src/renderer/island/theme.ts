import type { IslandTone } from './summary';

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

export const TONE_COLOR: Record<IslandTone, string> = {
  idle: ISLAND_COLORS.neutral,
  working: ISLAND_COLORS.blue,
  unread: ISLAND_COLORS.green,
  'needs-input': ISLAND_COLORS.orange,
};

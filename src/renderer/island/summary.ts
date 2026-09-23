import type { Provider, SessionSnapshot, SessionStatus } from '../../shared/session';
import { visibleTileSessions } from '../tiles/interaction';

/** The compact island only speaks in these four tones. */
export type IslandTone = 'idle' | 'working' | 'unread' | 'needs-input';

export interface IslandSummary {
  /** Indicator dots from left to right. */
  dots: readonly IslandTone[];
  /** Null while every thread is idle. */
  label: string | null;
  /** The thread the label names; clicking the island opens it. */
  target: SessionSnapshot | null;
}

export const ISLAND_PROVIDER_NAME: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
};

function latestWithStatus(
  sessions: readonly SessionSnapshot[],
  status: SessionStatus,
): SessionSnapshot | null {
  let latest: SessionSnapshot | null = null;
  for (const session of sessions) {
    if (session.status !== status) continue;
    if (latest === null || session.updatedAt > latest.updatedAt) latest = session;
  }
  return latest;
}

/**
 * Collapses every visible thread into the compact island: needs input beats
 * done, done beats working, and working beats idle. A done thread shown while
 * another thread still works keeps a blue dot on its left.
 */
export function summarizeIsland(sessions: readonly SessionSnapshot[]): IslandSummary {
  const visible = visibleTileSessions(sessions);

  const needsInput = latestWithStatus(visible, 'needs-input');
  if (needsInput !== null) {
    return {
      dots: ['needs-input'],
      label: `${ISLAND_PROVIDER_NAME[needsInput.provider]} needs input`,
      target: needsInput,
    };
  }

  const working = latestWithStatus(visible, 'working');
  const unread = latestWithStatus(visible, 'unread');
  if (unread !== null) {
    return {
      dots: working === null ? ['unread'] : ['working', 'unread'],
      label: `${ISLAND_PROVIDER_NAME[unread.provider]} is done`,
      target: unread,
    };
  }

  if (working !== null) {
    return {
      dots: ['working'],
      label: `${ISLAND_PROVIDER_NAME[working.provider]} is working`,
      target: working,
    };
  }

  return { dots: ['idle'], label: null, target: null };
}

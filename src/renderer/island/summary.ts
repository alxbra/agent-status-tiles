import type { Provider, SessionSnapshot } from '../../shared/session';
import { visibleIslandSessions } from './interaction';

/** The compact island only speaks in these four tones. */
export type IslandTone = 'idle' | 'working' | 'unread' | 'needs-input';

export interface IslandDot {
  /** The harness the dot stands for; absent on the lone idle dot. */
  provider?: Provider;
  tone: IslandTone;
}

export interface IslandSummary {
  /** Indicator dots from left to right; the labeled harness sits next to the label. */
  dots: readonly IslandDot[];
  /** Null while every thread is idle. */
  label: string | null;
  /** The thread the label names; clicking the island opens it. */
  target: SessionSnapshot | null;
}

type ActiveTone = Exclude<IslandTone, 'idle'>;

const ISLAND_PROVIDER_NAME: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
};

const LABEL_VERB: Record<ActiveTone, string> = {
  'needs-input': 'needs input',
  working: 'is working',
  unread: 'is done',
};

/** Within one harness, a running thread outranks one that finished. */
const HARNESS_RANK: Record<ActiveTone, number> = { 'needs-input': 0, working: 1, unread: 2 };
/** Across harnesses, the label favors what the user has to act on. */
const LABEL_RANK: Record<ActiveTone, number> = { 'needs-input': 0, unread: 1, working: 2 };

const HARNESS_ORDER: readonly Provider[] = ['codex', 'claude'];

interface HarnessState {
  provider: Provider;
  tone: ActiveTone;
  session: SessionSnapshot;
}

function isActiveTone(status: SessionSnapshot['status']): status is ActiveTone {
  return status === 'needs-input' || status === 'working' || status === 'unread';
}

/** Rank by the given order, breaking ties by the most recent update. */
function outranks(
  candidate: HarnessState,
  current: HarnessState,
  rank: Record<ActiveTone, number>,
): boolean {
  const difference = rank[candidate.tone] - rank[current.tone];
  return (
    difference < 0 || (difference === 0 && candidate.session.updatedAt > current.session.updatedAt)
  );
}

/** One harness's most important thread; errors and unavailable threads count as idle. */
function harnessState(
  provider: Provider,
  sessions: readonly SessionSnapshot[],
): HarnessState | null {
  let top: HarnessState | null = null;
  for (const session of sessions) {
    if (session.provider !== provider || !isActiveTone(session.status)) continue;
    const candidate: HarnessState = { provider, tone: session.status, session };
    if (top === null || outranks(candidate, top, HARNESS_RANK)) top = candidate;
  }
  return top;
}

/**
 * Collapses every visible thread into the compact island. Each harness shows
 * one dot for its most important thread (needs input, then working, then
 * done), idle harnesses show none, and the label names the harness with the
 * most actionable state (needs input, then done, then working). A single
 * white dot remains when every harness is idle.
 */
export function summarizeIsland(sessions: readonly SessionSnapshot[]): IslandSummary {
  const visible = visibleIslandSessions(sessions);
  const harnesses = HARNESS_ORDER.flatMap((provider) => {
    const state = harnessState(provider, visible);
    return state === null ? [] : [state];
  });

  let labeled: HarnessState | null = null;
  for (const state of harnesses) {
    if (labeled === null || outranks(state, labeled, LABEL_RANK)) labeled = state;
  }
  if (labeled === null) return { dots: [{ tone: 'idle' }], label: null, target: null };

  const others = harnesses.filter((state) => state !== labeled);
  return {
    dots: [...others, labeled].map(({ provider, tone }) => ({ provider, tone })),
    label: `${ISLAND_PROVIDER_NAME[labeled.provider]} ${LABEL_VERB[labeled.tone]}`,
    target: labeled.session,
  };
}

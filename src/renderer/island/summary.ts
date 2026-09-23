import type { Provider, SessionSnapshot } from '../../shared/session';
import { visibleIslandSessions } from './interaction';

/** A harness column is idle, working, or waiting for input; done counts as idle. */
export type HarnessTone = 'idle' | 'working' | 'needs-input';

export interface HarnessColumn {
  provider: Provider;
  tone: HarnessTone;
  /** The thread behind the tone; clicking the island opens the most urgent one. */
  target: SessionSnapshot | null;
}

export const HARNESS_NAME: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
};

/** Left to right; derived so a new provider cannot be left out. */
export const HARNESS_ORDER = Object.keys(HARNESS_NAME) as readonly Provider[];

const TONE_RANK: Record<HarnessTone, number> = { 'needs-input': 0, working: 1, idle: 2 };

function toneOf(status: SessionSnapshot['status']): HarnessTone {
  // Done, failed, and unavailable threads all read as idle.
  return status === 'needs-input' || status === 'working' ? status : 'idle';
}

/**
 * One column per harness, always present: needs input outranks working, which
 * outranks idle, and the most recently updated thread breaks a tie.
 */
export function summarizeHarnesses(sessions: readonly SessionSnapshot[]): readonly HarnessColumn[] {
  const visible = visibleIslandSessions(sessions);
  return HARNESS_ORDER.map((provider) => {
    let column: HarnessColumn = { provider, tone: 'idle', target: null };
    for (const session of visible) {
      if (session.provider !== provider) continue;
      const tone = toneOf(session.status);
      if (tone === 'idle') continue;
      const difference = TONE_RANK[tone] - TONE_RANK[column.tone];
      if (
        difference < 0 ||
        (difference === 0 && column.target !== null && session.updatedAt > column.target.updatedAt)
      ) {
        column = { provider, tone, target: session };
      }
    }
    return column;
  });
}

/** The thread a click opens: one waiting for input first, then the newest working one. */
export function islandTarget(columns: readonly HarnessColumn[]): SessionSnapshot | null {
  let best: { tone: HarnessTone; target: SessionSnapshot } | null = null;
  for (const { tone, target } of columns) {
    if (target === null) continue;
    if (
      best === null ||
      TONE_RANK[tone] < TONE_RANK[best.tone] ||
      (tone === best.tone && target.updatedAt > best.target.updatedAt)
    ) {
      best = { tone, target };
    }
  }
  return best?.target ?? null;
}

/** Each seen session's latest completion, used to notice a turn finishing. */
export type CompletionSnapshot = ReadonlyMap<string, string | undefined>;

/** Sessions remembered across updates, so a thread can leave and rejoin the recent list. */
export const MAX_REMEMBERED_COMPLETIONS = 256;

/**
 * Merge the visible sessions into the remembered completions. Sessions that
 * left the recent list stay remembered, newest first, up to the cap.
 */
export function completionSnapshot(
  previous: CompletionSnapshot | null,
  sessions: readonly SessionSnapshot[],
): CompletionSnapshot {
  const next = new Map<string, string | undefined>();
  for (const session of visibleIslandSessions(sessions)) next.set(session.id, session.completionId);
  for (const [id, completionId] of previous ?? []) {
    if (next.size >= MAX_REMEMBERED_COMPLETIONS) break;
    if (!next.has(id)) next.set(id, completionId);
  }
  return next;
}

/**
 * The harnesses with a turn that finished live since the previous snapshot. A
 * session seen for the first time only seeds the snapshot, so launching the
 * app never sounds. A completion that arrives already acknowledged, which is
 * how the runtime baselines replayed history, is not a live finish either.
 */
export function finishedHarnesses(
  previous: CompletionSnapshot | null,
  sessions: readonly SessionSnapshot[],
): ReadonlySet<Provider> {
  const finished = new Set<Provider>();
  if (previous === null) return finished;
  for (const session of visibleIslandSessions(sessions)) {
    if (!previous.has(session.id) || session.status === 'idle') continue;
    const completionId = session.completionId;
    if (completionId !== undefined && completionId !== previous.get(session.id)) {
      finished.add(session.provider);
    }
  }
  return finished;
}

import type { SessionSnapshot } from '../../shared/session';

export interface OpenSessionTarget {
  sessionId: string;
  completionId?: string;
}

/** Spawned subagents stay represented by their parent; archived threads never qualify. */
export function visibleIslandSessions(
  sessions: readonly SessionSnapshot[],
): readonly SessionSnapshot[] {
  return sessions.filter((session) => session.isTopLevel && !session.isArchived);
}

/** Capture both IDs before asynchronous navigation can change the snapshot. */
export function captureOpenTarget(session: SessionSnapshot): OpenSessionTarget {
  return {
    sessionId: session.id,
    ...(session.completionId === undefined ? {} : { completionId: session.completionId }),
  };
}

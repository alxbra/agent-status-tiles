import type { SessionSnapshot } from '../../shared/session';

export interface OpenSessionTarget {
  sessionId: string;
  completionId?: string;
}

export function visibleTileSessions(
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

/** Acknowledge only the completion that was visible at pointer-down time. */
export function canAcknowledgeTarget(
  target: OpenSessionTarget,
  current: SessionSnapshot | undefined,
): boolean {
  return (
    current !== undefined &&
    target.sessionId === current.id &&
    target.completionId !== undefined &&
    target.completionId === current.completionId
  );
}

/**
 * While the pointer is over the strip, preserve its list membership and order
 * while allowing status/completion changes through for the existing sessions.
 */
export function updateFrozenSessionStatuses(
  frozenSessions: readonly SessionSnapshot[],
  incomingSessions: readonly SessionSnapshot[],
): readonly SessionSnapshot[] {
  const incomingById = new Map(incomingSessions.map((session) => [session.id, session]));
  return frozenSessions.map((session) => {
    const incoming = incomingById.get(session.id);
    if (incoming === undefined) return session;
    return {
      ...session,
      status: incoming.status,
      updatedAt: incoming.updatedAt,
      completionId: incoming.completionId,
      canOpen: incoming.canOpen,
    };
  });
}

export function isSameSessionOrder(
  left: readonly SessionSnapshot[],
  right: readonly SessionSnapshot[],
): boolean {
  return (
    left.length === right.length && left.every((session, index) => session.id === right[index]?.id)
  );
}

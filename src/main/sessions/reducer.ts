import {
  makeSessionId,
  snapshotOf,
  type SessionEvent,
  type SessionRecord,
  type SessionSnapshot,
  type SessionState,
  type Provider,
  type TurnKey,
  type InputRequest,
} from '../../shared/session';

function compareTurnKeys(left: TurnKey, right: TurnKey): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  return left.turnId.localeCompare(right.turnId);
}

export function isNewerTurn(
  record: Pick<SessionRecord, 'turnKey'>,
  event: Extract<SessionEvent, { type: 'turn-started' }>,
): boolean {
  if (record.turnKey?.turnId === event.turnId) return false;
  if (record.turnKey === undefined) return true;
  return compareTurnKeys({ timestamp: event.timestamp, turnId: event.turnId }, record.turnKey) > 0;
}

function ownSession(
  sessions: Readonly<Record<string, SessionRecord>>,
  sessionId: string,
): SessionRecord | undefined {
  return Object.prototype.hasOwnProperty.call(sessions, sessionId)
    ? sessions[sessionId]
    : undefined;
}

function ownInputRequest(
  inputRequests: Readonly<Record<string, InputRequest>>,
  callId: string,
): InputRequest | undefined {
  return Object.prototype.hasOwnProperty.call(inputRequests, callId)
    ? inputRequests[callId]
    : undefined;
}

export function isCurrentTurn(
  record: Pick<SessionRecord, 'activeTurnId' | 'lastTurnStartedAt'>,
  turnId: string,
  timestamp: number,
): boolean {
  return record.activeTurnId === turnId && timestamp >= record.lastTurnStartedAt;
}

function statusFor(record: SessionRecord): SessionSnapshot['status'] {
  if (record.isFailed && !record.isErrorDismissed) return 'error';
  if (
    Object.values(record.inputRequests).some(
      (request) => request.turnId === record.activeTurnId && request.resolvedAt === undefined,
    )
  ) {
    return 'needs-input';
  }
  if (record.activeTurnId !== undefined) return 'working';
  if (
    record.completionId !== undefined &&
    record.completionId !== record.acknowledgedCompletionId
  ) {
    return 'unread';
  }
  return 'idle';
}

/** Recompute the public status after restoring internal session fields. */
export function refreshSessionRecord(record: SessionRecord): SessionRecord {
  const status = statusFor(record);
  return record.status === status ? record : { ...record, status };
}

function replaceRecord(
  state: SessionState,
  sessionId: string,
  record: SessionRecord,
  promote = false,
): SessionState {
  const order = promote ? promoteSession(state.order, sessionId) : state.order;
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: refreshSessionRecord(record) },
    ...(order === state.order ? {} : { order }),
  };
}

function withEventTime(record: SessionRecord, timestamp: number): Pick<SessionRecord, 'updatedAt'> {
  return { updatedAt: Math.max(record.updatedAt, timestamp) };
}

function initialRecord(
  event: Extract<SessionEvent, { type: 'upsert' }>,
  id: string,
): SessionRecord {
  return {
    id,
    provider: event.provider,
    surface: event.surface,
    nativeSessionId: event.nativeSessionId,
    title: event.title,
    status: 'idle',
    updatedAt: event.updatedAt,
    lastTurnStartedAt: 0,
    isTopLevel: event.isTopLevel,
    isArchived: event.isArchived,
    canOpen: event.canOpen,
    inputRequests: {},
    isFailed: false,
    isErrorDismissed: false,
    metadataUpdatedAt: event.updatedAt,
  };
}

function upsertSession(
  state: SessionState,
  event: Extract<SessionEvent, { type: 'upsert' }>,
): SessionState {
  const id = makeSessionId(event.provider, event.nativeSessionId);
  const previous = ownSession(state.sessions, id);
  if (previous === undefined) {
    return {
      ...state,
      sessions: { ...state.sessions, [id]: initialRecord(event, id) },
      order: state.order.includes(id) ? state.order : [...state.order, id],
    };
  }
  if (event.updatedAt < previous.metadataUpdatedAt) return state;

  const next: SessionRecord = {
    ...previous,
    provider: event.provider,
    surface: event.surface,
    nativeSessionId: event.nativeSessionId,
    title: event.title,
    isTopLevel: event.isTopLevel,
    isArchived: event.isArchived,
    canOpen: event.canOpen,
    metadataUpdatedAt: event.updatedAt,
    updatedAt: Math.max(previous.updatedAt, event.updatedAt),
  };
  if (
    previous.surface === next.surface &&
    previous.title === next.title &&
    previous.isTopLevel === next.isTopLevel &&
    previous.isArchived === next.isArchived &&
    previous.canOpen === next.canOpen &&
    previous.metadataUpdatedAt === next.metadataUpdatedAt
  ) {
    return state;
  }
  return replaceRecord(state, id, next);
}

export function reduceSessionState(state: SessionState, event: SessionEvent): SessionState {
  if (event.type === 'upsert') return upsertSession(state, event);

  if (event.type === 'provider-health') {
    const previous = state.providerHealth[event.provider];
    if (event.timestamp < previous.updatedAt) return state;
    if (event.timestamp === previous.updatedAt && event.status === previous.status) return state;
    return {
      ...state,
      providerHealth: {
        ...state.providerHealth,
        [event.provider]: { status: event.status, updatedAt: event.timestamp },
      },
    };
  }

  const previous = ownSession(state.sessions, event.sessionId);
  if (previous === undefined) return state;

  switch (event.type) {
    case 'turn-started': {
      if (!isNewerTurn(previous, event)) return state;
      return replaceRecord(
        state,
        event.sessionId,
        {
          ...previous,
          ...withEventTime(previous, event.timestamp),
          activeTurnId: event.turnId,
          turnKey: { timestamp: event.timestamp, turnId: event.turnId },
          lastTurnStartedAt: event.timestamp,
          completionId: undefined,
          acknowledgedCompletionId: undefined,
          inputRequests: {},
          isFailed: false,
          isErrorDismissed: false,
        },
        true,
      );
    }
    case 'activity': {
      if (previous.activeTurnId === undefined) return state;
      if (event.turnId !== undefined && event.turnId !== previous.activeTurnId) return state;
      if (event.timestamp < previous.lastTurnStartedAt) return state;
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        isFailed: false,
        isErrorDismissed: false,
      });
    }
    case 'input-requested': {
      if (!isCurrentTurn(previous, event.turnId, event.timestamp)) return state;
      const previousRequest = ownInputRequest(previous.inputRequests, event.callId);
      if (previousRequest !== undefined) {
        // A resolved request is a tombstone: replaying the request must not
        // make a completed wait visible again. Duplicate unresolved requests
        // are also no-ops, even when their timestamps arrive out of order.
        return state;
      }
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        inputRequests: {
          ...previous.inputRequests,
          [event.callId]: {
            turnId: event.turnId,
            requestedAt: event.timestamp,
          },
        },
      });
    }
    case 'input-resolved': {
      if (!isCurrentTurn(previous, event.turnId, event.timestamp)) return state;
      const previousRequest = ownInputRequest(previous.inputRequests, event.callId);
      if (previousRequest !== undefined) {
        if (
          previousRequest.turnId !== event.turnId ||
          previousRequest.resolvedAt !== undefined ||
          event.timestamp < previousRequest.requestedAt
        ) {
          return state;
        }
      }
      const inputRequest: InputRequest = {
        turnId: event.turnId,
        requestedAt: previousRequest?.requestedAt ?? event.timestamp,
        resolvedAt: event.timestamp,
      };
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        inputRequests: {
          ...previous.inputRequests,
          [event.callId]: inputRequest,
        },
      });
    }
    case 'turn-completed': {
      if (!isCurrentTurn(previous, event.turnId, event.timestamp)) return state;
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        activeTurnId: undefined,
        completionId: event.completionId,
        acknowledgedCompletionId: undefined,
        inputRequests: {},
        isFailed: false,
        isErrorDismissed: false,
      });
    }
    case 'turn-failed': {
      if (!isCurrentTurn(previous, event.turnId, event.timestamp)) return state;
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        activeTurnId: undefined,
        completionId: undefined,
        acknowledgedCompletionId: undefined,
        inputRequests: {},
        isFailed: true,
        isErrorDismissed: false,
      });
    }
    case 'acknowledged': {
      if (
        previous.completionId !== event.expectedCompletionId ||
        previous.acknowledgedCompletionId === event.expectedCompletionId
      ) {
        return state;
      }
      return replaceRecord(state, event.sessionId, {
        ...previous,
        updatedAt: previous.updatedAt,
        acknowledgedCompletionId: event.expectedCompletionId,
      });
    }
    case 'dismissed-error': {
      if (!previous.isFailed || previous.isErrorDismissed) return state;
      return replaceRecord(state, event.sessionId, {
        ...previous,
        updatedAt: previous.updatedAt,
        isErrorDismissed: true,
      });
    }
  }
}

export function promoteSession(order: readonly string[], sessionId: string): readonly string[] {
  if (order[0] === sessionId) return order;
  return [sessionId, ...order.filter((id) => id !== sessionId)];
}

export function selectSessionSnapshots(state: SessionState): readonly SessionSnapshot[] {
  return state.order.flatMap((id) => {
    const record = ownSession(state.sessions, id);
    return record === undefined ? [] : [snapshotOf(record)];
  });
}

export function selectSession(state: SessionState, sessionId: string): SessionSnapshot | undefined {
  const record = ownSession(state.sessions, sessionId);
  return record === undefined ? undefined : snapshotOf(record);
}

export function selectProviderHealth(state: SessionState, provider: Provider) {
  return state.providerHealth[provider];
}

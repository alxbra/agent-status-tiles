import {
  makeSessionId,
  snapshotOf,
  type SessionEvent,
  type SessionRecord,
  type SessionSnapshot,
  type SessionState,
  type Provider,
  type TurnKey,
} from "../../shared/session";

function compareTurnKeys(left: TurnKey, right: TurnKey): number {
  if (left.timestamp !== right.timestamp)
    return left.timestamp - right.timestamp;
  return left.turnId.localeCompare(right.turnId);
}

function isNewerTurn(
  record: SessionRecord,
  event: Extract<SessionEvent, { type: "turn-started" }>,
): boolean {
  if (record.lastTurnId === event.turnId) return false;
  if (record.turnKey === undefined) return true;
  return (
    compareTurnKeys(
      { timestamp: event.timestamp, turnId: event.turnId },
      record.turnKey,
    ) > 0
  );
}

function hasCurrentTurn(
  record: SessionRecord,
  turnId: string,
  timestamp: number,
): boolean {
  return record.activeTurnId === turnId && timestamp >= record.lastEventAt;
}

function statusFor(record: SessionRecord): SessionSnapshot["status"] {
  if (record.failed && !record.errorDismissed) return "error";
  if (Object.keys(record.pendingInputs).length > 0) return "needs-input";
  if (record.activeTurnId !== undefined) return "working";
  if (
    record.completionId !== undefined &&
    record.completionId !== record.acknowledgedCompletionId
  ) {
    return "unread";
  }
  return "idle";
}

function refreshStatus(record: SessionRecord): SessionRecord {
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
    sessions: { ...state.sessions, [sessionId]: refreshStatus(record) },
    ...(order === state.order ? {} : { order }),
  };
}

function withEventTime(
  record: SessionRecord,
  timestamp: number,
): Pick<SessionRecord, "updatedAt" | "lastEventAt"> {
  return {
    updatedAt: Math.max(record.updatedAt, timestamp),
    lastEventAt: timestamp,
  };
}

function initialRecord(
  event: Extract<SessionEvent, { type: "upsert" }>,
  id: string,
): SessionRecord {
  return {
    id,
    provider: event.provider,
    surface: event.surface,
    nativeSessionId: event.nativeSessionId,
    title: event.title,
    status: "idle",
    updatedAt: event.updatedAt,
    lastTurnStartedAt: 0,
    isTopLevel: event.isTopLevel,
    isArchived: event.isArchived,
    canOpen: event.canOpen,
    pendingInputs: {},
    failed: false,
    errorDismissed: false,
    metadataUpdatedAt: event.updatedAt,
    lastEventAt: 0,
  };
}

function upsertSession(
  state: SessionState,
  event: Extract<SessionEvent, { type: "upsert" }>,
): SessionState {
  const id = makeSessionId(event.provider, event.nativeSessionId);
  const previous = state.sessions[id];
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

export function reduceSessionState(
  state: SessionState,
  event: SessionEvent,
): SessionState {
  if (event.type === "upsert") return upsertSession(state, event);

  if (event.type === "provider-health") {
    const previous = state.providerHealth[event.provider];
    if (event.timestamp < previous.updatedAt) return state;
    if (
      event.timestamp === previous.updatedAt &&
      event.status === previous.status
    )
      return state;
    return {
      ...state,
      providerHealth: {
        ...state.providerHealth,
        [event.provider]: { status: event.status, updatedAt: event.timestamp },
      },
    };
  }

  const previous = state.sessions[event.sessionId];
  if (previous === undefined) return state;

  switch (event.type) {
    case "turn-started": {
      if (!isNewerTurn(previous, event)) return state;
      return replaceRecord(
        state,
        event.sessionId,
        {
          ...previous,
          ...withEventTime(previous, event.timestamp),
          activeTurnId: event.turnId,
          lastTurnId: event.turnId,
          turnKey: { timestamp: event.timestamp, turnId: event.turnId },
          lastTurnStartedAt: event.timestamp,
          completionId: undefined,
          acknowledgedCompletionId: undefined,
          pendingInputs: {},
          failed: false,
          errorDismissed: false,
        },
        true,
      );
    }
    case "activity": {
      if (previous.activeTurnId === undefined) return state;
      if (event.turnId !== undefined && event.turnId !== previous.activeTurnId)
        return state;
      if (event.timestamp < previous.lastEventAt) return state;
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        failed: false,
        errorDismissed: false,
      });
    }
    case "input-requested": {
      if (!hasCurrentTurn(previous, event.turnId, event.timestamp))
        return state;
      if (previous.pendingInputs[event.callId] === event.turnId) return state;
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        pendingInputs: {
          ...previous.pendingInputs,
          [event.callId]: event.turnId,
        },
      });
    }
    case "input-resolved": {
      if (!hasCurrentTurn(previous, event.turnId, event.timestamp))
        return state;
      if (previous.pendingInputs[event.callId] !== event.turnId) return state;
      const pendingInputs = { ...previous.pendingInputs };
      delete pendingInputs[event.callId];
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        pendingInputs,
      });
    }
    case "turn-completed": {
      if (!hasCurrentTurn(previous, event.turnId, event.timestamp))
        return state;
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        activeTurnId: undefined,
        completionId: event.completionId,
        acknowledgedCompletionId: undefined,
        pendingInputs: {},
        failed: false,
        errorDismissed: false,
      });
    }
    case "turn-failed": {
      if (!hasCurrentTurn(previous, event.turnId, event.timestamp))
        return state;
      return replaceRecord(state, event.sessionId, {
        ...previous,
        ...withEventTime(previous, event.timestamp),
        activeTurnId: undefined,
        completionId: undefined,
        acknowledgedCompletionId: undefined,
        pendingInputs: {},
        failed: true,
        errorDismissed: false,
      });
    }
    case "acknowledged": {
      if (
        previous.completionId !== event.expectedCompletionId ||
        previous.acknowledgedCompletionId === event.expectedCompletionId
      ) {
        return state;
      }
      return replaceRecord(state, event.sessionId, {
        ...previous,
        updatedAt: Math.max(previous.updatedAt, event.timestamp),
        acknowledgedCompletionId: event.expectedCompletionId,
      });
    }
    case "dismissed-error": {
      if (!previous.failed || previous.errorDismissed) return state;
      return replaceRecord(state, event.sessionId, {
        ...previous,
        updatedAt: Math.max(previous.updatedAt, event.timestamp),
        errorDismissed: true,
      });
    }
  }
}

export function promoteSession(
  order: readonly string[],
  sessionId: string,
): readonly string[] {
  if (order[0] === sessionId) return order;
  return [sessionId, ...order.filter((id) => id !== sessionId)];
}

export function selectSessionSnapshots(
  state: SessionState,
): readonly SessionSnapshot[] {
  return state.order.flatMap((id) => {
    const record = state.sessions[id];
    return record === undefined ? [] : [snapshotOf(record)];
  });
}

export function selectVisibleSessionSnapshots(
  state: SessionState,
): readonly SessionSnapshot[] {
  return selectSessionSnapshots(state).filter(
    (session) =>
      session.isTopLevel &&
      !session.isArchived &&
      session.status !== "idle" &&
      session.status !== "unavailable",
  );
}

export function selectSession(
  state: SessionState,
  sessionId: string,
): SessionSnapshot | undefined {
  const record = state.sessions[sessionId];
  return record === undefined ? undefined : snapshotOf(record);
}

export function selectProviderHealth(state: SessionState, provider: Provider) {
  return state.providerHealth[provider];
}

export type Provider = 'codex' | 'claude';

export type Surface = 'desktop' | 'cli';

export type SessionStatus = 'idle' | 'working' | 'needs-input' | 'unread' | 'error' | 'unavailable';

export type ProviderHealthStatus = 'unknown' | 'available' | 'unavailable' | 'error';

export interface SessionSnapshot {
  id: string;
  provider: Provider;
  surface: Surface;
  title: string;
  status: SessionStatus;
  updatedAt: number;
  lastTurnStartedAt: number;
  completionId?: string;
  isTopLevel: boolean;
  isArchived: boolean;
  canOpen: boolean;
}

export interface TurnKey {
  timestamp: number;
  turnId: string;
}

export interface InputRequest {
  turnId: string;
  requestedAt: number;
  resolvedAt?: number;
}

/** Internal state retained by the main process; do not send this object to the renderer. */
export interface SessionRecord extends SessionSnapshot {
  nativeSessionId: string;
  activeTurnId?: string;
  turnKey?: TurnKey;
  /** Resolved entries are retained as turn-scoped tombstones for replay safety. */
  inputRequests: Readonly<Record<string, InputRequest>>;
  acknowledgedCompletionId?: string;
  isFailed: boolean;
  isErrorDismissed: boolean;
  metadataUpdatedAt: number;
}

export interface ProviderHealthSnapshot {
  status: ProviderHealthStatus;
  updatedAt: number;
}

export interface SessionState {
  sessions: Readonly<Record<string, SessionRecord>>;
  order: readonly string[];
  providerHealth: Readonly<Record<Provider, ProviderHealthSnapshot>>;
}

export type SessionEvent =
  | {
      type: 'upsert';
      provider: Provider;
      nativeSessionId: string;
      surface: Surface;
      title: string;
      isTopLevel: boolean;
      isArchived: boolean;
      canOpen: boolean;
      updatedAt: number;
    }
  | {
      type: 'turn-started';
      sessionId: string;
      turnId: string;
      timestamp: number;
    }
  | { type: 'activity'; sessionId: string; turnId?: string; timestamp: number }
  | {
      type: 'input-requested';
      sessionId: string;
      turnId: string;
      callId: string;
      timestamp: number;
    }
  | {
      type: 'input-resolved';
      sessionId: string;
      turnId: string;
      callId: string;
      timestamp: number;
    }
  | {
      type: 'turn-completed';
      sessionId: string;
      turnId: string;
      completionId: string;
      timestamp: number;
    }
  | {
      type: 'turn-failed';
      sessionId: string;
      turnId: string;
      timestamp: number;
    }
  | {
      type: 'acknowledged';
      sessionId: string;
      expectedCompletionId: string;
      timestamp: number;
    }
  | { type: 'dismissed-error'; sessionId: string; timestamp: number }
  | {
      type: 'provider-health';
      provider: Provider;
      status: ProviderHealthStatus;
      timestamp: number;
    };

export function makeSessionId(provider: Provider, nativeSessionId: string): string {
  return `${provider}:${nativeSessionId}`;
}

export function createInitialSessionState(): SessionState {
  return {
    sessions: {},
    order: [],
    providerHealth: {
      codex: { status: 'unknown', updatedAt: 0 },
      claude: { status: 'unknown', updatedAt: 0 },
    },
  };
}

export function isProvider(value: unknown): value is Provider {
  return value === 'codex' || value === 'claude';
}

export function isSurface(value: unknown): value is Surface {
  return value === 'desktop' || value === 'cli';
}

export function isProviderHealthStatus(value: unknown): value is ProviderHealthStatus {
  return (
    value === 'unknown' || value === 'available' || value === 'unavailable' || value === 'error'
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export const MAX_ID_BYTES = 256;
export const MAX_SESSION_ID_BYTES = MAX_ID_BYTES + 'claude:'.length;
export const MAX_TITLE_BYTES = 256;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    isNonEmptyString(value) &&
    value.trim().length > 0 &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

/** Runtime validation for untrusted provider events before they enter the reducer. */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (!isBoundedString(event.type, 64)) return false;

  switch (event.type) {
    case 'upsert':
      return (
        isProvider(event.provider) &&
        isBoundedString(event.nativeSessionId, MAX_ID_BYTES) &&
        isSurface(event.surface) &&
        isBoundedString(event.title, MAX_TITLE_BYTES) &&
        typeof event.isTopLevel === 'boolean' &&
        typeof event.isArchived === 'boolean' &&
        typeof event.canOpen === 'boolean' &&
        isTimestamp(event.updatedAt)
      );
    case 'provider-health':
      return (
        isProvider(event.provider) &&
        isProviderHealthStatus(event.status) &&
        isTimestamp(event.timestamp)
      );
    case 'turn-started':
      return (
        isBoundedString(event.sessionId, MAX_SESSION_ID_BYTES) &&
        isBoundedString(event.turnId, MAX_ID_BYTES) &&
        isTimestamp(event.timestamp)
      );
    case 'activity':
      return (
        isBoundedString(event.sessionId, MAX_SESSION_ID_BYTES) &&
        (event.turnId === undefined || isBoundedString(event.turnId, MAX_ID_BYTES)) &&
        isTimestamp(event.timestamp)
      );
    case 'input-requested':
    case 'input-resolved':
      return (
        isBoundedString(event.sessionId, MAX_SESSION_ID_BYTES) &&
        isBoundedString(event.turnId, MAX_ID_BYTES) &&
        isBoundedString(event.callId, MAX_ID_BYTES) &&
        isTimestamp(event.timestamp)
      );
    case 'turn-completed':
      return (
        isBoundedString(event.sessionId, MAX_SESSION_ID_BYTES) &&
        isBoundedString(event.turnId, MAX_ID_BYTES) &&
        isBoundedString(event.completionId, MAX_ID_BYTES) &&
        isTimestamp(event.timestamp)
      );
    case 'turn-failed':
      return (
        isBoundedString(event.sessionId, MAX_SESSION_ID_BYTES) &&
        isBoundedString(event.turnId, MAX_ID_BYTES) &&
        isTimestamp(event.timestamp)
      );
    case 'acknowledged':
      return (
        isBoundedString(event.sessionId, MAX_SESSION_ID_BYTES) &&
        isBoundedString(event.expectedCompletionId, MAX_ID_BYTES) &&
        isTimestamp(event.timestamp)
      );
    case 'dismissed-error':
      return isBoundedString(event.sessionId, MAX_SESSION_ID_BYTES) && isTimestamp(event.timestamp);
    default:
      return false;
  }
}

export function snapshotOf(record: SessionRecord): SessionSnapshot {
  return {
    id: record.id,
    provider: record.provider,
    surface: record.surface,
    title: record.title,
    status: record.status,
    updatedAt: record.updatedAt,
    lastTurnStartedAt: record.lastTurnStartedAt,
    ...(record.completionId === undefined ? {} : { completionId: record.completionId }),
    isTopLevel: record.isTopLevel,
    isArchived: record.isArchived,
    canOpen: record.canOpen,
  };
}

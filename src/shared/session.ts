export const PROVIDERS = ["codex", "claude"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const SURFACES = ["desktop", "cli"] as const;
export type Surface = (typeof SURFACES)[number];

export type SessionStatus =
  "idle" | "working" | "needs-input" | "unread" | "error" | "unavailable";

export type ProviderHealthStatus =
  "unknown" | "available" | "unavailable" | "error";

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

/** Internal state retained by the main process; do not send this object to the renderer. */
export interface SessionRecord extends SessionSnapshot {
  nativeSessionId: string;
  activeTurnId?: string;
  lastTurnId?: string;
  turnKey?: TurnKey;
  pendingInputs: Readonly<Record<string, string>>;
  acknowledgedCompletionId?: string;
  failed: boolean;
  errorDismissed: boolean;
  metadataUpdatedAt: number;
  lastEventAt: number;
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
      type: "upsert";
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
      type: "turn-started";
      sessionId: string;
      turnId: string;
      timestamp: number;
    }
  | { type: "activity"; sessionId: string; turnId?: string; timestamp: number }
  | {
      type: "input-requested";
      sessionId: string;
      turnId: string;
      callId: string;
      timestamp: number;
    }
  | {
      type: "input-resolved";
      sessionId: string;
      turnId: string;
      callId: string;
      timestamp: number;
    }
  | {
      type: "turn-completed";
      sessionId: string;
      turnId: string;
      completionId: string;
      timestamp: number;
    }
  | {
      type: "turn-failed";
      sessionId: string;
      turnId: string;
      timestamp: number;
    }
  | {
      type: "acknowledged";
      sessionId: string;
      expectedCompletionId: string;
      timestamp: number;
    }
  | { type: "dismissed-error"; sessionId: string; timestamp: number }
  | {
      type: "provider-health";
      provider: Provider;
      status: ProviderHealthStatus;
      timestamp: number;
    };

export function makeSessionId(
  provider: Provider,
  nativeSessionId: string,
): string {
  return `${provider}:${nativeSessionId}`;
}

export function createInitialSessionState(): SessionState {
  return {
    sessions: {},
    order: [],
    providerHealth: {
      codex: { status: "unknown", updatedAt: 0 },
      claude: { status: "unknown", updatedAt: 0 },
    },
  };
}

export function isProvider(value: unknown): value is Provider {
  return value === "codex" || value === "claude";
}

export function isSurface(value: unknown): value is Surface {
  return value === "desktop" || value === "cli";
}

export function isProviderHealthStatus(
  value: unknown,
): value is ProviderHealthStatus {
  return (
    value === "unknown" ||
    value === "available" ||
    value === "unavailable" ||
    value === "error"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Runtime validation for untrusted provider events before they enter the reducer. */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string") return false;

  switch (event.type) {
    case "upsert":
      return (
        isProvider(event.provider) &&
        isNonEmptyString(event.nativeSessionId) &&
        isSurface(event.surface) &&
        typeof event.title === "string" &&
        typeof event.isTopLevel === "boolean" &&
        typeof event.isArchived === "boolean" &&
        typeof event.canOpen === "boolean" &&
        isTimestamp(event.updatedAt)
      );
    case "provider-health":
      return (
        isProvider(event.provider) &&
        isProviderHealthStatus(event.status) &&
        isTimestamp(event.timestamp)
      );
    case "turn-started":
      return (
        isNonEmptyString(event.sessionId) &&
        isNonEmptyString(event.turnId) &&
        isTimestamp(event.timestamp)
      );
    case "activity":
      return (
        isNonEmptyString(event.sessionId) &&
        (event.turnId === undefined || isNonEmptyString(event.turnId)) &&
        isTimestamp(event.timestamp)
      );
    case "input-requested":
    case "input-resolved":
      return (
        isNonEmptyString(event.sessionId) &&
        isNonEmptyString(event.turnId) &&
        isNonEmptyString(event.callId) &&
        isTimestamp(event.timestamp)
      );
    case "turn-completed":
      return (
        isNonEmptyString(event.sessionId) &&
        isNonEmptyString(event.turnId) &&
        isNonEmptyString(event.completionId) &&
        isTimestamp(event.timestamp)
      );
    case "turn-failed":
      return (
        isNonEmptyString(event.sessionId) &&
        isNonEmptyString(event.turnId) &&
        isTimestamp(event.timestamp)
      );
    case "acknowledged":
      return (
        isNonEmptyString(event.sessionId) &&
        isNonEmptyString(event.expectedCompletionId) &&
        isTimestamp(event.timestamp)
      );
    case "dismissed-error":
      return isNonEmptyString(event.sessionId) && isTimestamp(event.timestamp);
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
    ...(record.completionId === undefined
      ? {}
      : { completionId: record.completionId }),
    isTopLevel: record.isTopLevel,
    isArchived: record.isArchived,
    canOpen: record.canOpen,
  };
}

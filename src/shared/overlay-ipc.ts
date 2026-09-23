import {
  MAX_ID_BYTES,
  MAX_SESSION_ID_BYTES,
  MAX_TITLE_BYTES,
  type SessionSnapshot,
  type SessionStatus,
} from './session';

export const OVERLAY_IPC_CHANNELS = {
  getState: 'overlay:get-state',
  stateChanged: 'overlay:state-changed',
  keyboardEntry: 'overlay:keyboard-entry',
  keyboardExit: 'overlay:keyboard-exit',
  rendererReady: 'overlay:renderer-ready',
  publishHitRegions: 'overlay:publish-hit-regions',
  openSession: 'overlay:open-session',
  dismissError: 'overlay:dismiss-error',
} as const;

export const MAX_OVERLAY_SESSIONS = 256;
// The compact island publishes one region; the cap bounds untrusted renderer
// input and leaves room for an expanded island.
export const MAX_OVERLAY_HIT_REGIONS = 14;

export interface OverlayState {
  sessions: readonly SessionSnapshot[];
  reducedMotion: boolean;
}

/** Geometry only crosses the renderer boundary; session IDs stay in the state projection. */
export interface OverlayHitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayOpenSessionRequest {
  sessionId: string;
  completionId?: string;
}

export interface OverlayDismissErrorRequest {
  sessionId: string;
}

export interface OverlayActionResult {
  handled: false;
  reason: 'unavailable';
}

export const OVERLAY_ACTION_UNAVAILABLE: OverlayActionResult = {
  handled: false,
  reason: 'unavailable',
};

export interface AgentStatusTilesOverlayApi {
  getState(): Promise<OverlayState>;
  subscribe(listener: (state: OverlayState) => void): () => void;
  subscribeKeyboardEntry(listener: () => void): () => void;
  requestKeyboardExit(): Promise<void>;
  rendererReady(): Promise<void>;
  publishHitRegions(regions: readonly OverlayHitRegion[]): Promise<boolean>;
  openSession(request: OverlayOpenSessionRequest): Promise<OverlayActionResult>;
  dismissError(request: OverlayDismissErrorRequest): Promise<OverlayActionResult>;
}

const PROVIDERS = new Set(['codex', 'claude']);
const SURFACES = new Set(['desktop', 'cli']);
const STATUSES = new Set<SessionStatus>([
  'idle',
  'working',
  'needs-input',
  'unread',
  'error',
  'unavailable',
]);
const SESSION_KEYS = [
  'id',
  'provider',
  'surface',
  'title',
  'status',
  'updatedAt',
  'lastTurnStartedAt',
  'isTopLevel',
  'isArchived',
  'canOpen',
];
const SESSION_KEYS_WITH_COMPLETION = [...SESSION_KEYS, 'completionId'];
const STATE_KEYS = ['sessions', 'reducedMotion'];
const HIT_REGION_KEYS = ['x', 'y', 'width', 'height'];
const OPEN_REQUEST_KEYS = ['sessionId'];
const OPEN_REQUEST_KEYS_WITH_COMPLETION = ['sessionId', 'completionId'];
const DISMISS_REQUEST_KEYS = ['sessionId'];
const ACTION_RESULT_KEYS = ['handled', 'reason'];
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export function isOverlayNoPayload(value: unknown): value is undefined {
  return value === undefined;
}

export const isOverlayKeyboardExitRequest = isOverlayNoPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (!isRecord(value)) return false;
  const hasCompletionId = Object.hasOwn(value, 'completionId');
  if (!hasExactKeys(value, hasCompletionId ? SESSION_KEYS_WITH_COMPLETION : SESSION_KEYS)) {
    return false;
  }

  return (
    isBoundedString(value.id, MAX_SESSION_ID_BYTES) &&
    PROVIDERS.has(value.provider as string) &&
    SURFACES.has(value.surface as string) &&
    isBoundedString(value.title, MAX_TITLE_BYTES) &&
    STATUSES.has(value.status as SessionStatus) &&
    isTimestamp(value.updatedAt) &&
    isTimestamp(value.lastTurnStartedAt) &&
    (!hasCompletionId || isBoundedString(value.completionId, MAX_ID_BYTES)) &&
    typeof value.isTopLevel === 'boolean' &&
    typeof value.isArchived === 'boolean' &&
    typeof value.canOpen === 'boolean'
  );
}

export function isOverlayState(value: unknown): value is OverlayState {
  if (!isRecord(value) || !hasExactKeys(value, STATE_KEYS)) return false;
  if (!Array.isArray(value.sessions) || value.sessions.length > MAX_OVERLAY_SESSIONS) {
    return false;
  }
  if (!value.sessions.every(isSessionSnapshot)) return false;
  const sessionIds = new Set(value.sessions.map((session) => session.id));
  return sessionIds.size === value.sessions.length && typeof value.reducedMotion === 'boolean';
}

export function isOverlayActionResult(value: unknown): value is OverlayActionResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ACTION_RESULT_KEYS) &&
    value.handled === false &&
    value.reason === 'unavailable'
  );
}

export function isOverlayHitRegions(value: unknown): value is readonly OverlayHitRegion[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_OVERLAY_HIT_REGIONS &&
    value.every((region) => {
      if (!isRecord(region) || !hasExactKeys(region, HIT_REGION_KEYS)) return false;
      return (
        typeof region.x === 'number' &&
        Number.isFinite(region.x) &&
        region.x >= 0 &&
        typeof region.y === 'number' &&
        Number.isFinite(region.y) &&
        region.y >= 0 &&
        typeof region.width === 'number' &&
        Number.isFinite(region.width) &&
        region.width > 0 &&
        typeof region.height === 'number' &&
        Number.isFinite(region.height) &&
        region.height > 0
      );
    })
  );
}

export function isOverlayOpenSessionRequest(value: unknown): value is OverlayOpenSessionRequest {
  if (!isRecord(value)) return false;
  const hasCompletionId = Object.hasOwn(value, 'completionId');
  return (
    hasExactKeys(value, hasCompletionId ? OPEN_REQUEST_KEYS_WITH_COMPLETION : OPEN_REQUEST_KEYS) &&
    isBoundedString(value.sessionId, MAX_SESSION_ID_BYTES) &&
    (!hasCompletionId || isBoundedString(value.completionId, MAX_ID_BYTES))
  );
}

export function isOverlayDismissErrorRequest(value: unknown): value is OverlayDismissErrorRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, DISMISS_REQUEST_KEYS) &&
    isBoundedString(value.sessionId, MAX_SESSION_ID_BYTES)
  );
}

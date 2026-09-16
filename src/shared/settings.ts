/** The synthetic selection that always resolves to the current primary display. */
export const PRIMARY_DISPLAY_ID = 'primary';

export const DESKTOP_PREFERENCES_SCHEMA_VERSION = 2 as const;
export const DEFAULT_RECENT_THREAD_LIMIT = 5;
export const MAX_RECENT_THREAD_LIMIT = 10;
export const MAX_SETTINGS_DISPLAYS = 32;
export const MAX_DISPLAY_LABEL_BYTES = 256;

export type SettingsProviderConnectionStatus =
  'connected' | 'connecting' | 'disconnected' | 'unavailable';

export type SettingsConnectionKey = 'codexDesktop' | 'codexCli' | 'claudeCode';

export interface SettingsProviderState {
  status: SettingsProviderConnectionStatus;
  canConnect: boolean;
  canDisconnect: boolean;
}

export interface SettingsDisplayOption {
  id: string;
  label: string;
}

/** The complete state projection exposed to the Settings renderer. */
export interface SettingsState {
  providers: Readonly<Record<SettingsConnectionKey, SettingsProviderState>>;
  displays: readonly SettingsDisplayOption[];
  selectedDisplayId: string;
  launchAtLogin: boolean;
  reduceMotion: boolean;
  recentThreadLimit: number;
  /** Actionable native settings failure, never diagnostic or path data. */
  error?: string;
}

export interface DisplayPreferenceChangeRequest {
  displayId: string;
}

export interface ReduceMotionPreferenceChangeRequest {
  enabled: boolean;
}

export interface LaunchAtLoginChangeRequest {
  enabled: boolean;
}

export interface RecentThreadLimitChangeRequest {
  limit: number;
}

export function isRecentThreadLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_RECENT_THREAD_LIMIT
  );
}

export interface SettingsConnectionRequest {
  connection: SettingsConnectionKey;
}

export interface SettingsDisconnectRequest extends SettingsConnectionRequest {
  confirmed: true;
}

const CONNECTION_STATUSES = new Set<SettingsProviderConnectionStatus>([
  'connected',
  'connecting',
  'disconnected',
  'unavailable',
]);
const PROVIDER_KEYS = ['codexDesktop', 'codexCli', 'claudeCode'] as const;
const STATE_KEYS = [
  'providers',
  'displays',
  'selectedDisplayId',
  'launchAtLogin',
  'reduceMotion',
  'recentThreadLimit',
] as const;
const STATE_KEYS_WITH_ERROR = [...STATE_KEYS, 'error'] as const;
const PROVIDER_STATE_KEYS = ['status', 'canConnect', 'canDisconnect'] as const;
const DISPLAY_KEYS = ['id', 'label'] as const;
const DISPLAY_REQUEST_KEYS = ['displayId'] as const;
const BOOLEAN_REQUEST_KEYS = ['enabled'] as const;
const CONNECTION_REQUEST_KEYS = ['connection'] as const;
const DISCONNECT_REQUEST_KEYS = ['connection', 'confirmed'] as const;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const MAX_DISPLAY_ID_BYTES = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

/** Electron display IDs are numbers and are serialized without lossy coercion. */
export function isSerializedDisplayId(value: unknown): value is string {
  return (
    value === PRIMARY_DISPLAY_ID ||
    (typeof value === 'string' &&
      /^(?:0|[1-9]\d*)$/.test(value) &&
      new TextEncoder().encode(value).byteLength <= MAX_DISPLAY_ID_BYTES)
  );
}

function isProviderState(value: unknown): value is SettingsProviderState {
  return (
    isRecord(value) &&
    hasExactKeys(value, PROVIDER_STATE_KEYS) &&
    CONNECTION_STATUSES.has(value.status as SettingsProviderConnectionStatus) &&
    typeof value.canConnect === 'boolean' &&
    typeof value.canDisconnect === 'boolean'
  );
}

export function isSettingsConnectionKey(value: unknown): value is SettingsConnectionKey {
  return typeof value === 'string' && PROVIDER_KEYS.some((key) => key === value);
}

export function isSettingsConnectionRequest(value: unknown): value is SettingsConnectionRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONNECTION_REQUEST_KEYS) &&
    isSettingsConnectionKey(value.connection)
  );
}

export function isSettingsDisconnectRequest(value: unknown): value is SettingsDisconnectRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, DISCONNECT_REQUEST_KEYS) &&
    isSettingsConnectionKey(value.connection) &&
    value.confirmed === true
  );
}

function isSettingsDisplayOption(value: unknown): value is SettingsDisplayOption {
  return (
    isRecord(value) &&
    hasExactKeys(value, DISPLAY_KEYS) &&
    isSerializedDisplayId(value.id) &&
    isBoundedText(value.label, MAX_DISPLAY_LABEL_BYTES)
  );
}

export function isSettingsState(value: unknown): value is SettingsState {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, STATE_KEYS) && !hasExactKeys(value, STATE_KEYS_WITH_ERROR))
  ) {
    return false;
  }
  const providers = value.providers;
  if (!isRecord(providers)) return false;
  if (
    Object.keys(providers).length !== PROVIDER_KEYS.length ||
    !PROVIDER_KEYS.every((provider) => isProviderState(providers[provider]))
  ) {
    return false;
  }
  if (
    !Array.isArray(value.displays) ||
    value.displays.length === 0 ||
    value.displays.length > MAX_SETTINGS_DISPLAYS ||
    !value.displays.every(isSettingsDisplayOption)
  ) {
    return false;
  }
  const displayIds = new Set(value.displays.map((display) => display.id));
  return (
    displayIds.size === value.displays.length &&
    displayIds.has(PRIMARY_DISPLAY_ID) &&
    isSerializedDisplayId(value.selectedDisplayId) &&
    displayIds.has(value.selectedDisplayId) &&
    typeof value.launchAtLogin === 'boolean' &&
    typeof value.reduceMotion === 'boolean' &&
    isRecentThreadLimit(value.recentThreadLimit) &&
    (value.error === undefined || isBoundedText(value.error, 512))
  );
}

export function isDisplayPreferenceChangeRequest(
  value: unknown,
): value is DisplayPreferenceChangeRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, DISPLAY_REQUEST_KEYS) &&
    isSerializedDisplayId(value.displayId)
  );
}

export function isReduceMotionPreferenceChangeRequest(
  value: unknown,
): value is ReduceMotionPreferenceChangeRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, BOOLEAN_REQUEST_KEYS) &&
    typeof value.enabled === 'boolean'
  );
}

export function isLaunchAtLoginChangeRequest(value: unknown): value is LaunchAtLoginChangeRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, BOOLEAN_REQUEST_KEYS) &&
    typeof value.enabled === 'boolean'
  );
}

export function isRecentThreadLimitChangeRequest(
  value: unknown,
): value is RecentThreadLimitChangeRequest {
  return isRecord(value) && hasExactKeys(value, ['limit']) && isRecentThreadLimit(value.limit);
}

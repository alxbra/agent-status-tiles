import type { Provider } from './session';

/** The synthetic selection that always resolves to the current primary display. */
export const PRIMARY_DISPLAY_ID = 'primary';

export const DESKTOP_PREFERENCES_SCHEMA_VERSION = 1 as const;
export const MAX_SETTINGS_DISPLAYS = 32;
export const MAX_DISPLAY_LABEL_BYTES = 256;

export type SettingsProviderConnectionStatus =
  'connected' | 'connecting' | 'disconnected' | 'unavailable';

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
  providers: Readonly<Record<Provider, SettingsProviderState>>;
  displays: readonly SettingsDisplayOption[];
  selectedDisplayId: string;
  launchAtLogin: boolean;
  reduceMotion: boolean;
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

const CONNECTION_STATUSES = new Set<SettingsProviderConnectionStatus>([
  'connected',
  'connecting',
  'disconnected',
  'unavailable',
]);
const PROVIDER_KEYS = ['codex', 'claude'] as const;
const STATE_KEYS = [
  'providers',
  'displays',
  'selectedDisplayId',
  'launchAtLogin',
  'reduceMotion',
] as const;
const STATE_KEYS_WITH_ERROR = [...STATE_KEYS, 'error'] as const;
const PROVIDER_STATE_KEYS = ['status', 'canConnect', 'canDisconnect'] as const;
const DISPLAY_KEYS = ['id', 'label'] as const;
const DISPLAY_REQUEST_KEYS = ['displayId'] as const;
const BOOLEAN_REQUEST_KEYS = ['enabled'] as const;
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

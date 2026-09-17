import type { FileCursor } from './cursor';
import type { Provider, SessionRecord, Surface } from './session';

/** The four local monitoring surfaces; Settings connects them per provider. */
export type SurfaceKey = `${Provider}:${Surface}`;

export const SURFACE_KEYS: readonly SurfaceKey[] = [
  'codex:desktop',
  'codex:cli',
  'claude:desktop',
  'claude:cli',
];

export type BaselineStatus = 'pending' | 'ready';

/** A pending baseline suppresses historical completions until its cutoff is observed. */
export type SurfaceBaseline =
  { status: 'pending'; cutoff?: undefined } | { status: 'ready'; cutoff: number };

/** Persisted state for exactly one provider/surface integration. */
export interface MonitoringPartition {
  enabled: boolean;
  baseline: SurfaceBaseline;
  sessions: Readonly<Record<string, SessionRecord>>;
  order: readonly string[];
  /** Relative source IDs only; the provider and surface are supplied by the partition key. */
  cursors: SurfaceCursorMap;
  /** Records retained from schema v1 until the user explicitly reconnects or disconnects. */
  legacyRetained: boolean;
}

/** Root persisted monitoring state. Provider health is intentionally transient and absent. */
export interface MonitoringState {
  partitions: Readonly<Record<SurfaceKey, MonitoringPartition>>;
  /** One canonical provider:nativeId entry per retained session, in display order. */
  globalOrder: readonly string[];
  /** Optional owner choice for canonical IDs duplicated across multiple surfaces. */
  owners: Readonly<Record<string, SurfaceKey>>;
}

export type SurfaceCursorMap = Readonly<Record<string, FileCursor>>;

export function surfaceKey(provider: Provider, surface: Surface): SurfaceKey {
  return `${provider}:${surface}`;
}

export function parseSurfaceKey(value: unknown): SurfaceKey | undefined {
  return typeof value === 'string' && (SURFACE_KEYS as readonly string[]).includes(value)
    ? (value as SurfaceKey)
    : undefined;
}

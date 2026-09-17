import {
  SURFACE_KEYS,
  surfaceKey,
  type MonitoringPartition,
  type MonitoringState,
  type SurfaceCursorMap,
  type SurfaceKey,
} from '../../shared/monitoring';
import {
  isProvider,
  isSessionEvent,
  makeSessionId,
  type Provider,
  type ProviderHealthStatus,
  type SessionEvent,
  type SessionRecord,
  type SessionSnapshot,
  type SessionState,
  type Surface,
} from '../../shared/session';
import type { OverlayState } from '../../shared/overlay-ipc';
import {
  connectMonitoringSurface,
  createInitialMonitoringState,
  disconnectMonitoringSurface,
  loadSessionState,
  saveSessionState,
  type SessionLoadResult,
} from '../sessions/persistence';
import { reduceSessionState, selectSessionSnapshots } from '../sessions/reducer';
import { DEFAULT_RECENT_THREAD_LIMIT, isRecentThreadLimit } from '../../shared/settings';

/** Catalog/source limits intentionally mirror the persistence bounds. */
export const MAX_RUNTIME_SOURCES = 512;
export const MAX_RUNTIME_SOURCE_ID_BYTES = 256;
export const MAX_RUNTIME_TITLE_BYTES = 256;
export const DEFAULT_FILE_POLL_INTERVAL_MS = 250;
export const DEFAULT_CATALOG_POLL_INTERVAL_MS = 2_000;
export const MAX_RETRY_INTERVAL_MS = 15_000;
export const MAX_OVERLAY_RUNTIME_SESSIONS = 256;
export const MAX_RETAINED_RUNTIME_SESSIONS = 1_024;
/** Reader output is bounded before it can be retained in a candidate state. */
export const MAX_RUNTIME_EVENTS_PER_READ = 4_096;
// Ten recent Codex rollouts can produce more than 16k historical events.
// Keep a fixed aggregate bound while allowing their initial baseline to finish.
export const MAX_RUNTIME_EVENTS_PER_REPLAY = 65_536;

export type RuntimeHealthStatus = 'starting' | 'available' | 'unavailable' | 'error' | 'stopped';

/**
 * A catalog result contains only display-safe metadata. Paths and provider
 * records remain inside the injected monitor and never enter persisted state.
 */
export interface RuntimeMonitorSource {
  /** Relative, monitor-owned source identifier used as the cursor key. */
  id: string;
  nativeSessionId: string;
  /** Previous Codex rollout identity, used only for one-to-one local state migration. */
  legacySessionId?: string;
  title: string;
  updatedAt: number;
  isTopLevel: boolean;
  isArchived: boolean;
  /** PR2 intentionally has no navigation primitive. */
  canOpen?: false;
  /** A monitor may provide a fixed source EOF during baseline capture. */
  endOffset?: number;
}

export interface RuntimeDiscoveryResult {
  /** No replay or baseline commit is allowed until discovery is complete. */
  complete: boolean;
  capturedAt: number;
  sources: readonly RuntimeMonitorSource[];
  /** Confirmed sources are usable, but plausible records were omitted. */
  coverageIncomplete?: boolean;
}

export interface RuntimeReadRequest {
  sources: readonly RuntimeMonitorSource[];
  cursors: SurfaceCursorMap;
  /** Last durable records restore turn context for incremental rollout parsing. */
  sessions: Readonly<Record<string, SessionRecord>>;
  /** Captured EOFs are immutable for the entire baseline replay. */
  frozenCutoffs: Readonly<Record<string, number>>;
  baseline: boolean;
  /** Optional continuation index for bounded readers. */
  sourceStart?: number;
}

export interface RuntimeEventEnvelope {
  event: SessionEvent;
  /** Readers may mark an event historical; baseline replay treats all events as historical. */
  historical?: boolean;
  sourceId?: string;
}

export interface RuntimeReadResult {
  events: readonly (SessionEvent | RuntimeEventEnvelope)[];
  cursors: SurfaceCursorMap;
  /** True only when every requested frozen source reached its captured boundary. */
  complete: boolean;
  /** Non-structural records were skipped; confirmed observations remain usable. */
  coverageIncomplete?: boolean;
  /** Confirmed sources whose status-bearing history could not be read safely. */
  unavailableSourceIds?: readonly string[];
  /** Explicit exhaustion is allowed for a source with no byte cursor (e.g. a bounded API). */
  exhaustedSourceIds?: readonly string[];
  /** Readers may return a continuation index when their work budget is exhausted. */
  nextSourceIndex?: number;
}

/**
 * Injection-friendly provider-neutral monitor boundary. Adapters implement this
 * interface with sanitized observations; tests inject fakes.
 */
export interface ProviderSurfaceMonitor {
  readonly key: SurfaceKey;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  /**
   * Report the newest eligible sessions for this surface, at most
   * `RECENT_THREAD_DISCOVERY_WINDOW` of them, ordered by recency where the
   * provider offers it. The result is the complete cohort: on a completed
   * discovery the coordinator drops every persisted session the surface no
   * longer reports, whatever its status, and a session reappears when the
   * provider reports it again. Adapters must not enumerate beyond the window
   * (for example archived or historical records) to explain an absence; they
   * report what the dock can show and leave removal to the coordinator.
   */
  discover(): Promise<RuntimeDiscoveryResult>;
  /** Optional fixed-EOF capture hook. If absent, discovery's sources are used. */
  capture?(
    sources: readonly RuntimeMonitorSource[],
  ): readonly RuntimeMonitorSource[] | Promise<readonly RuntimeMonitorSource[]>;
  read(request: RuntimeReadRequest): Promise<RuntimeReadResult>;
}

export interface RuntimeSurfaceHealth {
  status: RuntimeHealthStatus;
  updatedAt: number;
  retryInMs?: number;
  coverageIncomplete?: true;
}

export interface RuntimeCoordinatorOptions {
  appDataPath: string;
  recentThreadLimit?: number;
  monitors?: readonly ProviderSurfaceMonitor[];
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  filePollIntervalMs?: number;
  catalogPollIntervalMs?: number;
  maxRetryIntervalMs?: number;
  /** State is published only after its corresponding checkpoint succeeds. */
  onOverlayState?: (state: OverlayState) => void;
  /** A bounded count is sufficient for Settings; no session metadata crosses this callback. */
  onCoverageWarning?: (omittedCount: number) => void;
  onHealthChanged?: (key: SurfaceKey, health: RuntimeSurfaceHealth) => void;
}

export interface RuntimeCoordinator {
  start(): Promise<void>;
  /** Pause readers for sleep without forgetting enabled surfaces. */
  suspend(): Promise<void>;
  resume(): Promise<void>;
  /** Terminal cleanup; subsequent resume/start calls are no-ops. */
  stop(): Promise<void>;
  shutdown(): Promise<void>;
  connect(provider: Provider, surface: Surface): Promise<void>;
  disconnect(provider: Provider, surface: Surface): Promise<void>;
  acknowledge(sessionId: string, completionId: string): Promise<boolean>;
  dismissError(sessionId: string): Promise<boolean>;
  getMonitoringState(): MonitoringState;
  getHealth(): Readonly<Record<SurfaceKey, RuntimeSurfaceHealth>>;
  getOverlayState(): OverlayState;
  getCoverageWarning(): string | undefined;
  setRecentThreadLimit(limit: number): void;
}

interface SurfaceRuntime {
  readonly key: SurfaceKey;
  readonly monitor?: ProviderSurfaceMonitor;
  sources: readonly RuntimeMonitorSource[];
  coverageIncomplete: boolean;
  unavailableSourceIds: Set<string>;
  lastCatalogAt: number;
  retryMs: number;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
  starting?: Promise<void>;
  inFlight?: Promise<void>;
  generation: number;
}

interface PendingEvent {
  event: SessionEvent;
  historical: boolean;
  sourceId?: string;
  sequence: number;
}

function own<T>(value: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function clonePartition(partition: MonitoringPartition): MonitoringPartition {
  return {
    enabled: partition.enabled,
    baseline:
      partition.baseline.status === 'ready'
        ? { status: 'ready', cutoff: partition.baseline.cutoff }
        : { status: 'pending' },
    sessions: { ...partition.sessions },
    order: [...partition.order],
    cursors: { ...partition.cursors },
    legacyRetained: partition.legacyRetained,
  };
}

function cloneMonitoringState(state: MonitoringState): MonitoringState {
  const partitions = {} as Record<SurfaceKey, MonitoringPartition>;
  for (const key of SURFACE_KEYS) partitions[key] = clonePartition(state.partitions[key]);
  return {
    partitions,
    globalOrder: [...state.globalOrder],
    owners: { ...state.owners },
  };
}

function cloneHealth(
  health: Readonly<Record<SurfaceKey, RuntimeSurfaceHealth>>,
): Readonly<Record<SurfaceKey, RuntimeSurfaceHealth>> {
  const result = {} as Record<SurfaceKey, RuntimeSurfaceHealth>;
  for (const key of SURFACE_KEYS) result[key] = { ...health[key] };
  return result;
}

function validSourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !/\p{Cc}/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= MAX_RUNTIME_SOURCE_ID_BYTES &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

function validTitle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !/\p{Cc}/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= MAX_RUNTIME_TITLE_BYTES
  );
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validCursor(value: unknown): value is {
  identity: string;
  offset: number;
  baselineUntilOffset?: number;
  isDiscardingOversizedLine?: boolean;
} {
  if (value === null || typeof value !== 'object') return false;
  const cursor = value as Record<string, unknown>;
  return (
    validTitle(cursor.identity) &&
    validTimestamp(cursor.offset) &&
    (cursor.baselineUntilOffset === undefined || validTimestamp(cursor.baselineUntilOffset)) &&
    (cursor.isDiscardingOversizedLine === undefined ||
      typeof cursor.isDiscardingOversizedLine === 'boolean')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function sanitizeSources(
  sources: readonly RuntimeMonitorSource[],
): readonly RuntimeMonitorSource[] {
  const result: RuntimeMonitorSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (
      !validSourceId(source.id) ||
      seen.has(source.id) ||
      !validTitle(source.title) ||
      !validSourceId(source.nativeSessionId) ||
      (source.legacySessionId !== undefined && !validSourceId(source.legacySessionId)) ||
      !validTimestamp(source.updatedAt) ||
      typeof source.isTopLevel !== 'boolean' ||
      typeof source.isArchived !== 'boolean' ||
      (source.endOffset !== undefined && !validTimestamp(source.endOffset))
    ) {
      throw new Error('invalid-source-catalog');
    }
    if (result.length >= MAX_RUNTIME_SOURCES) throw new Error('source-catalog-overflow');
    seen.add(source.id);
    result.push({
      id: source.id,
      nativeSessionId: source.nativeSessionId,
      ...(source.legacySessionId === undefined ? {} : { legacySessionId: source.legacySessionId }),
      title: source.title,
      updatedAt: source.updatedAt,
      isTopLevel: source.isTopLevel,
      isArchived: source.isArchived,
      canOpen: false,
      ...(source.endOffset === undefined ? {} : { endOffset: source.endOffset }),
    });
  }
  return result;
}

function sourceCutoffs(
  sources: readonly RuntimeMonitorSource[],
  baseline: boolean,
  newlyObservedSourceIds: ReadonlySet<string>,
): Readonly<Record<string, number>> {
  const cutoffs: Record<string, number> = {};
  for (const source of sources) {
    if (baseline || newlyObservedSourceIds.has(source.id)) {
      if (source.endOffset === undefined) throw new Error('baseline-cutoff-missing');
      cutoffs[source.id] = source.endOffset;
    }
  }
  return cutoffs;
}

function reconcileOwners(
  state: MonitoringState,
  savedOwners: Readonly<Record<string, SurfaceKey>>,
): void {
  const candidateIds = new Set<string>();
  for (const key of SURFACE_KEYS) {
    for (const id of Object.keys(state.partitions[key].sessions)) candidateIds.add(id);
  }
  const owners = state.owners as Record<string, SurfaceKey>;
  for (const id of Object.keys(owners)) {
    if (!candidateIds.has(id)) delete owners[id];
  }
  for (const id of candidateIds) {
    const candidates = SURFACE_KEYS.flatMap((key) => {
      const partition = state.partitions[key];
      if (!partition.enabled || partition.baseline.status !== 'ready') return [];
      const record = own(state.partitions[key].sessions, id);
      return record === undefined ? [] : [{ key, record }];
    });
    if (candidates.length === 0) {
      delete owners[id];
      continue;
    }
    if (candidates.length === 1) {
      owners[id] = candidates[0].key;
      continue;
    }
    const savedOwner = own(savedOwners, id);
    candidates.sort((left, right) => {
      // Metadata/catalog recency wins over lifecycle recency. This keeps a
      // stale duplicate from replacing a newer catalog observation.
      const metadataDelta = right.record.metadataUpdatedAt - left.record.metadataUpdatedAt;
      if (metadataDelta !== 0) return metadataDelta;
      const lifecycleDelta = right.record.updatedAt - left.record.updatedAt;
      if (lifecycleDelta !== 0) return lifecycleDelta;
      // Exact ties preserve the checkpointed choice. A first observation with
      // no saved choice uses desktop as the deterministic tie-breaker.
      if (savedOwner === left.key) return -1;
      if (savedOwner === right.key) return 1;
      const leftDesktop = left.key.endsWith(':desktop');
      const rightDesktop = right.key.endsWith(':desktop');
      if (leftDesktop !== rightDesktop) return leftDesktop ? -1 : 1;
      return left.key.localeCompare(right.key);
    });
    owners[id] = candidates[0].key;
  }
}

function readComplete(
  sources: readonly RuntimeMonitorSource[],
  cursors: SurfaceCursorMap,
  exhaustedSourceIds: ReadonlySet<string>,
): boolean {
  return sources.every((source) => {
    if (exhaustedSourceIds.has(source.id) || source.endOffset === undefined) return true;
    const cursor = cursors[source.id];
    return cursor !== undefined && cursor.offset >= source.endOffset;
  });
}

function enforceRetentionCap(state: MonitoringState): void {
  if (state.globalOrder.length <= MAX_RETAINED_RUNTIME_SESSIONS) return;
  const active = state.globalOrder.filter((id) => {
    const owner =
      state.owners[id] ?? SURFACE_KEYS.find((key) => own(state.partitions[key].sessions, id));
    const record = owner === undefined ? undefined : own(state.partitions[owner].sessions, id);
    return record !== undefined && record.status !== 'idle';
  });
  if (active.length > MAX_RETAINED_RUNTIME_SESSIONS) throw new Error('session-retention-overflow');
  const keep = new Set([
    ...active,
    ...state.globalOrder
      .filter((id) => !active.includes(id))
      .slice(0, MAX_RETAINED_RUNTIME_SESSIONS - active.length),
  ]);
  for (const key of SURFACE_KEYS) {
    const partition = state.partitions[key];
    const sessions = {} as Record<string, SessionRecord>;
    for (const id of partition.order) {
      const record = own(partition.sessions, id);
      if (record !== undefined && keep.has(id)) sessions[id] = record;
    }
    partition.sessions = sessions;
    partition.order = partition.order.filter((id) => keep.has(id));
  }
  state.globalOrder = state.globalOrder.filter((id) => keep.has(id));
  const owners = state.owners as Record<string, SurfaceKey>;
  for (const id of Object.keys(owners)) if (!keep.has(id)) delete owners[id];
}

function surfaceState(partition: MonitoringPartition, provider: Provider): SessionState {
  return {
    sessions: partition.sessions,
    order: partition.order,
    providerHealth: {
      codex: { status: provider === 'codex' ? 'available' : 'unknown', updatedAt: 0 },
      claude: { status: provider === 'claude' ? 'available' : 'unknown', updatedAt: 0 },
    },
  };
}

function normalizeEnvelope(
  value: SessionEvent | RuntimeEventEnvelope,
  baseline: boolean,
  sequence: number,
): PendingEvent {
  if (!isRecord(value)) throw new Error('invalid-read-event');
  const record = value as Record<string, unknown>;
  const hasEnvelope = Object.prototype.hasOwnProperty.call(record, 'event');
  const eventValue = hasEnvelope ? record.event : record;
  if (!isSessionEvent(eventValue)) throw new Error('invalid-read-event');
  if (
    hasEnvelope &&
    ((record.sourceId !== undefined && typeof record.sourceId !== 'string') ||
      (record.historical !== undefined && typeof record.historical !== 'boolean'))
  ) {
    throw new Error('invalid-read-event');
  }
  if (
    hasEnvelope &&
    ((record.historical !== undefined && typeof record.historical !== 'boolean') ||
      (record.sourceId !== undefined && typeof record.sourceId !== 'string'))
  ) {
    throw new Error('invalid-event-envelope');
  }
  const sanitizedEvent: SessionEvent =
    eventValue.type === 'upsert' ? { ...eventValue, canOpen: false } : eventValue;
  return {
    event: sanitizedEvent,
    historical: baseline || (hasEnvelope && record.historical === true),
    ...(hasEnvelope && typeof record.sourceId === 'string' ? { sourceId: record.sourceId } : {}),
    sequence,
  };
}

function eventNativeSessionId(event: SessionEvent): string | undefined {
  if (event.type === 'upsert') return event.nativeSessionId;
  if (event.type === 'provider-health') return undefined;
  const separator = event.sessionId.indexOf(':');
  return separator < 1 ? undefined : event.sessionId.slice(separator + 1);
}

function validateEventSource(
  pending: PendingEvent,
  sources: readonly RuntimeMonitorSource[],
): void {
  if (pending.event.type === 'provider-health') return;
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const nativeSessionId = eventNativeSessionId(pending.event);
  if (nativeSessionId === undefined) throw new Error('event-source-mismatch');
  if (pending.sourceId !== undefined) {
    const source = sourceById.get(pending.sourceId);
    if (source === undefined || source.nativeSessionId !== nativeSessionId) {
      throw new Error('event-source-mismatch');
    }
    return;
  }
  // Readers may omit sourceId, but the session must still belong to the
  // captured cohort. The adapter cannot use an unrelated source to mutate a
  // retained session in this surface.
  if (!sources.some((source) => source.nativeSessionId === nativeSessionId)) {
    throw new Error('event-source-mismatch');
  }
}

function mergeReadCursors(
  sources: readonly RuntimeMonitorSource[],
  previous: SurfaceCursorMap,
  incoming: unknown,
): SurfaceCursorMap {
  if (!isRecord(incoming)) throw new Error('invalid-read-cursors');
  const allowed = new Set(sources.map((source) => source.id));
  const next: Record<
    string,
    {
      identity: string;
      offset: number;
      baselineUntilOffset?: number;
      isDiscardingOversizedLine?: boolean;
    }
  > = {
    ...previous,
  };
  const entries = Object.entries(incoming);
  if (entries.length > MAX_RUNTIME_SOURCES) throw new Error('read-cursor-overflow');
  for (const [sourceId, value] of entries) {
    if (!allowed.has(sourceId) || !validCursor(value)) throw new Error('invalid-read-cursors');
    const old = previous[sourceId];
    if (old !== undefined && old.identity === value.identity && value.offset < old.offset) {
      throw new Error('read-cursor-regression');
    }
    next[sourceId] = value;
  }
  return next;
}

function eventTimestamp(event: SessionEvent): number {
  return event.type === 'upsert' ? event.updatedAt : event.timestamp;
}

function sortEvents(events: readonly PendingEvent[]): readonly PendingEvent[] {
  return [...events].sort(
    (left, right) =>
      eventTimestamp(left.event) - eventTimestamp(right.event) || left.sequence - right.sequence,
  );
}

function partitionRecordState(partition: MonitoringPartition, key: SurfaceKey): SessionState {
  return surfaceState(partition, key.split(':')[0] as Provider);
}

function safeEventForSurface(event: SessionEvent, key: SurfaceKey): boolean {
  const [provider, surface] = key.split(':') as [Provider, Surface];
  if (event.type === 'upsert') return event.provider === provider && event.surface === surface;
  if (event.type === 'provider-health') return event.provider === provider;
  return event.sessionId.startsWith(`${provider}:`);
}

function globalOrderWith(
  state: MonitoringState,
  _key: SurfaceKey,
  partition: MonitoringPartition,
  promotedIds: readonly string[],
): readonly string[] {
  const retained = new Set<string>();
  for (const candidate of SURFACE_KEYS) {
    for (const id of Object.keys(state.partitions[candidate].sessions)) retained.add(id);
  }
  const order = state.globalOrder.filter((id) => retained.has(id));
  const next = [...order];
  for (const id of partition.order) if (!next.includes(id)) next.push(id);
  for (const id of promotedIds) {
    if (!retained.has(id)) continue;
    next.splice(next.indexOf(id), 1);
    next.unshift(id);
  }
  // Partition order is authoritative for newly discovered records while the
  // global list remains deterministic across concurrent surfaces.
  for (const id of partition.order) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

function effectiveSessionState(
  monitoring: MonitoringState,
  health: Readonly<Record<SurfaceKey, RuntimeSurfaceHealth>>,
): SessionState {
  const sessions: Record<string, SessionRecord> = {};
  for (const id of monitoring.globalOrder) {
    const explicitOwner = monitoring.owners[id];
    const owner =
      explicitOwner !== undefined &&
      monitoring.partitions[explicitOwner].enabled &&
      monitoring.partitions[explicitOwner].baseline.status === 'ready' &&
      own(monitoring.partitions[explicitOwner].sessions, id) !== undefined
        ? explicitOwner
        : SURFACE_KEYS.find(
            (key) =>
              monitoring.partitions[key].enabled &&
              monitoring.partitions[key].baseline.status === 'ready' &&
              own(monitoring.partitions[key].sessions, id) !== undefined,
          );
    if (owner === undefined) continue;
    const record = own(monitoring.partitions[owner].sessions, id);
    if (record !== undefined) sessions[id] = record;
  }
  const providerHealth: Record<Provider, { status: ProviderHealthStatus; updatedAt: number }> = {
    codex: { status: 'unavailable', updatedAt: 0 },
    claude: { status: 'unavailable', updatedAt: 0 },
  };
  for (const provider of ['codex', 'claude'] as const) {
    const surfaces = SURFACE_KEYS.filter((key) => key.startsWith(`${provider}:`));
    const available = surfaces.some((key) => health[key].status === 'available');
    const errors = surfaces.some((key) => health[key].status === 'error');
    providerHealth[provider] = {
      status: available ? 'available' : errors ? 'error' : 'unavailable',
      updatedAt: Math.max(...surfaces.map((key) => health[key].updatedAt)),
    };
  }
  return {
    sessions,
    order: monitoring.globalOrder.filter((id) => own(sessions, id) !== undefined),
    providerHealth,
  };
}

function overlaySessions(
  monitoring: MonitoringState,
  health: Readonly<Record<SurfaceKey, RuntimeSurfaceHealth>>,
  surfaces: ReadonlyMap<SurfaceKey, SurfaceRuntime>,
  limit: number = MAX_OVERLAY_RUNTIME_SESSIONS,
): { sessions: readonly SessionSnapshot[]; omittedCount: number } {
  const sessionState = effectiveSessionState(monitoring, health);
  const visible = selectSessionSnapshots(sessionState).filter(
    (session) => session.isTopLevel && !session.isArchived,
  );
  const confirmedIds = new Map(
    [...surfaces].map(([key, runtime]) => [
      key,
      new Set(
        runtime.sources
          .filter((source) => !runtime.unavailableSourceIds.has(source.id))
          .map((source) => makeSessionId(providerFromKey(key), source.nativeSessionId)),
      ),
    ]),
  );
  const unavailableIds = new Map(
    [...surfaces].map(([key, runtime]) => [
      key,
      new Set(
        runtime.sources
          .filter((source) => runtime.unavailableSourceIds.has(source.id))
          .map((source) => makeSessionId(providerFromKey(key), source.nativeSessionId)),
      ),
    ]),
  );
  const ownerFor = (id: string): SurfaceKey | undefined => {
    const explicit = monitoring.owners[id];
    if (
      explicit !== undefined &&
      monitoring.partitions[explicit].enabled &&
      monitoring.partitions[explicit].baseline.status === 'ready' &&
      own(monitoring.partitions[explicit].sessions, id) !== undefined
    ) {
      return explicit;
    }
    return SURFACE_KEYS.find(
      (key) =>
        monitoring.partitions[key].enabled &&
        monitoring.partitions[key].baseline.status === 'ready' &&
        own(monitoring.partitions[key].sessions, id) !== undefined,
    );
  };
  const ordered = [...visible].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const mapped = ordered.map((snapshot) => {
    const owner = ownerFor(snapshot.id);
    return owner !== undefined &&
      (health[owner].status !== 'available' ||
        unavailableIds.get(owner)?.has(snapshot.id) ||
        (health[owner].coverageIncomplete === true && !confirmedIds.get(owner)?.has(snapshot.id)))
      ? { ...snapshot, status: 'unavailable' as const }
      : snapshot;
  });
  return {
    sessions: mapped.slice(0, Math.min(limit, MAX_OVERLAY_RUNTIME_SESSIONS)),
    omittedCount: Math.max(0, mapped.length - MAX_OVERLAY_RUNTIME_SESSIONS),
  };
}

function initialHealth(now: number): Record<SurfaceKey, RuntimeSurfaceHealth> {
  const health = {} as Record<SurfaceKey, RuntimeSurfaceHealth>;
  for (const key of SURFACE_KEYS) health[key] = { status: 'stopped', updatedAt: now };
  return health;
}

function providerFromKey(key: SurfaceKey): Provider {
  const provider = key.split(':')[0];
  if (!isProvider(provider)) throw new Error(`Invalid surface key ${key}`);
  return provider;
}

function surfaceFromKey(key: SurfaceKey): Surface {
  return key.split(':')[1] as Surface;
}

export function createRuntimeCoordinator(options: RuntimeCoordinatorOptions): RuntimeCoordinator {
  let recentThreadLimit = options.recentThreadLimit ?? DEFAULT_RECENT_THREAD_LIMIT;
  if (!isRecentThreadLimit(recentThreadLimit)) throw new Error('Invalid recent thread limit');
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  const filePollIntervalMs = Math.max(
    1,
    options.filePollIntervalMs ?? DEFAULT_FILE_POLL_INTERVAL_MS,
  );
  const catalogPollIntervalMs = Math.max(
    filePollIntervalMs,
    options.catalogPollIntervalMs ?? DEFAULT_CATALOG_POLL_INTERVAL_MS,
  );
  const maxRetryIntervalMs = Math.min(
    MAX_RETRY_INTERVAL_MS,
    Math.max(filePollIntervalMs, options.maxRetryIntervalMs ?? MAX_RETRY_INTERVAL_MS),
  );
  const monitorByKey = new Map<SurfaceKey, ProviderSurfaceMonitor>();
  for (const monitor of options.monitors ?? []) {
    if (!SURFACE_KEYS.includes(monitor.key)) throw new Error(`Unsupported monitor ${monitor.key}`);
    if (monitorByKey.has(monitor.key)) throw new Error(`Duplicate monitor ${monitor.key}`);
    monitorByKey.set(monitor.key, monitor);
  }
  const surfaces = new Map<SurfaceKey, SurfaceRuntime>();
  for (const key of SURFACE_KEYS) {
    surfaces.set(key, {
      key,
      monitor: monitorByKey.get(key),
      sources: [],
      coverageIncomplete: false,
      unavailableSourceIds: new Set(),
      lastCatalogAt: 0,
      retryMs: filePollIntervalMs,
      busy: false,
      generation: 0,
    });
  }

  let monitoring = createInitialMonitoringState();
  let health = initialHealth(now());
  let overlay: OverlayState = { sessions: [], reducedMotion: false };
  let coverageWarning: string | undefined;
  let generation = 0;
  let started = false;
  let suspended = false;
  let stopped = false;
  let loadPromise: Promise<SessionLoadResult> | undefined;
  let loaded = false;
  let commitTail = Promise.resolve();

  async function withCommitLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = commitTail;
    let release!: () => void;
    commitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  const publish = (): void => {
    const projected = overlaySessions(monitoring, health, surfaces, recentThreadLimit);
    overlay = { sessions: projected.sessions, reducedMotion: overlay.reducedMotion };
    coverageWarning =
      projected.omittedCount > 0
        ? `${projected.omittedCount} additional sessions are hidden from the overlay.`
        : undefined;
    options.onCoverageWarning?.(projected.omittedCount);
    options.onOverlayState?.(overlay);
  };

  const setHealth = (
    key: SurfaceKey,
    status: RuntimeHealthStatus,
    retryInMs?: number,
    coverageIncomplete?: boolean,
  ): void => {
    health = {
      ...health,
      [key]: {
        status,
        updatedAt: now(),
        ...(retryInMs === undefined ? {} : { retryInMs }),
        ...(coverageIncomplete ? { coverageIncomplete: true } : {}),
      },
    };
    options.onHealthChanged?.(key, health[key]);
  };

  const clearTimer = (runtime: SurfaceRuntime): void => {
    if (runtime.timer !== undefined) {
      cancel(runtime.timer);
      runtime.timer = undefined;
    }
  };

  const scheduleSurface = (
    runtime: SurfaceRuntime,
    delay: number,
    expectedGeneration: number,
    expectedSurfaceGeneration: number,
  ): void => {
    clearTimer(runtime);
    if (
      stopped ||
      suspended ||
      !started ||
      expectedGeneration !== generation ||
      expectedSurfaceGeneration !== runtime.generation
    )
      return;
    runtime.timer = schedule(() => {
      runtime.timer = undefined;
      if (
        stopped ||
        suspended ||
        !started ||
        expectedGeneration !== generation ||
        expectedSurfaceGeneration !== runtime.generation
      )
        return;
      void launchSurfaceRead(runtime, expectedGeneration, expectedSurfaceGeneration, false);
    }, delay);
  };

  const saveAndPublish = async (
    candidate: MonitoringState,
    expectedGeneration: number,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> => {
    if (stopped || expectedGeneration !== generation || !isCurrent()) return false;
    await saveSessionState(options.appDataPath, candidate);
    // A generation can be invalidated while the atomic write is in flight.
    // Once the write succeeds, memory must adopt that checkpoint even if its
    // stale reader must not publish or schedule more work.
    monitoring = candidate;
    if (stopped || expectedGeneration !== generation || !isCurrent()) return false;
    publish();
    return true;
  };

  const applyRead = async (
    runtime: SurfaceRuntime,
    sources: readonly RuntimeMonitorSource[],
    capturedAt: number,
    read: RuntimeReadResult,
    expectedGeneration: number,
    expectedSurfaceGeneration: number,
    pruneUnobserved: boolean,
  ): Promise<void> => {
    await withCommitLock(async () => {
      if (
        stopped ||
        expectedGeneration !== generation ||
        expectedSurfaceGeneration !== runtime.generation
      )
        return;
      const key = runtime.key;
      const [provider, surface] = [providerFromKey(key), surfaceFromKey(key)];
      const previous = monitoring;
      const candidate = cloneMonitoringState(previous);
      const partition = candidate.partitions[key];
      const previousRecords = { ...partition.sessions };
      let nextState = partitionRecordState(partition, key);
      const promoted: string[] = [];
      const pending: PendingEvent[] = [];
      const historicalSessionIds = new Set<string>();
      let sequence = 0;

      // Discovery is metadata-only and therefore safe to apply before replay.
      for (const source of sources) {
        const upsert: SessionEvent = {
          type: 'upsert',
          provider,
          nativeSessionId: source.nativeSessionId,
          surface,
          title: source.title,
          isTopLevel: source.isTopLevel,
          isArchived: source.isArchived,
          canOpen: false,
          updatedAt: source.updatedAt,
        };
        nextState = reduceSessionState(nextState, upsert);
        const id = makeSessionId(provider, source.nativeSessionId);
        (candidate.owners as Record<string, SurfaceKey>)[id] = key;
      }
      if (pruneUnobserved) {
        // A completed catalog is the newest live page and is authoritative for
        // the surface cohort. Anything it no longer reports, whatever its
        // status, has left that page (archived, deleted, or aged out) and is
        // dropped; it reappears when the thread is updated again.
        const observedIds = new Set(
          sources.map((source) => makeSessionId(provider, source.nativeSessionId)),
        );
        const sessions: Record<string, SessionRecord> = {};
        const order: string[] = [];
        for (const id of nextState.order) {
          const record = own(nextState.sessions, id);
          if (record === undefined || !observedIds.has(id)) continue;
          sessions[id] = record;
          order.push(id);
        }
        nextState = { ...nextState, sessions, order };
      }
      for (const value of read.events) {
        const event = normalizeEnvelope(value, partition.baseline.status === 'pending', sequence++);
        if (!safeEventForSurface(event.event, key)) throw new Error('event-surface-mismatch');
        pending.push(event);
      }
      for (const pendingEvent of sortEvents(pending)) {
        const event = pendingEvent.event;
        if (event.type === 'provider-health') continue;
        if (pendingEvent.historical && event.type !== 'upsert') {
          historicalSessionIds.add(event.sessionId);
        }
        const before = nextState;
        nextState = reduceSessionState(nextState, event);
        if (nextState !== before && event.type === 'turn-started') promoted.push(event.sessionId);
      }
      partition.sessions = { ...nextState.sessions };
      partition.order = [...nextState.order];
      // Drop cursors for sources no longer discovered so churn cannot exhaust
      // the bounded persisted cursor map.
      partition.cursors = pruneUnobserved
        ? { ...read.cursors }
        : { ...partition.cursors, ...read.cursors };
      const baseline = partition.baseline.status === 'pending';
      if (baseline || historicalSessionIds.size > 0) {
        // Normalize only newly observed terminal states. Existing migrated v1
        // acknowledgements/dismissals are replayed and preserved below.
        for (const id of partition.order) {
          if (!baseline && !historicalSessionIds.has(id)) continue;
          const current = partition.sessions[id];
          const old = previousRecords[id];
          if (current === undefined) continue;
          const shouldAcknowledge =
            current.status === 'unread' &&
            ((old?.acknowledgedCompletionId === current.completionId &&
              current.completionId !== undefined) ||
              old === undefined ||
              old.completionId !== current.completionId);
          const shouldDismiss =
            current.status === 'error' &&
            (old?.isErrorDismissed === true || old === undefined || !old.isFailed);
          if (shouldAcknowledge && current.completionId !== undefined) {
            nextState = reduceSessionState(nextState, {
              type: 'acknowledged',
              sessionId: id,
              expectedCompletionId: current.completionId,
              timestamp: Math.max(current.updatedAt, capturedAt),
            });
          } else if (shouldDismiss) {
            nextState = reduceSessionState(nextState, {
              type: 'dismissed-error',
              sessionId: id,
              timestamp: Math.max(current.updatedAt, capturedAt),
            });
          }
        }
        partition.sessions = { ...nextState.sessions };
        partition.order = [...nextState.order];
      }
      if (baseline) {
        const baselineCutoff = validTimestamp(capturedAt) ? capturedAt : now();
        partition.baseline = { status: 'ready', cutoff: baselineCutoff };
      }
      candidate.globalOrder = globalOrderWith(candidate, key, partition, promoted);
      if (partition.order.some((id) => candidate.globalOrder.includes(id))) {
        const globalOrder = candidate.globalOrder as string[];
        for (const id of partition.order) if (!globalOrder.includes(id)) globalOrder.push(id);
      }
      reconcileOwners(candidate, previous.owners);
      enforceRetentionCap(candidate);
      const retainedOwners = candidate.owners as Record<string, SurfaceKey>;
      for (const id of Object.keys(retainedOwners)) {
        if (!candidate.globalOrder.includes(id)) delete retainedOwners[id];
      }
      await saveAndPublish(
        candidate,
        expectedGeneration,
        () => expectedSurfaceGeneration === runtime.generation,
      );
    });
  };

  const captureSources = async (
    monitor: ProviderSurfaceMonitor,
    discovery: RuntimeDiscoveryResult,
  ): Promise<readonly RuntimeMonitorSource[]> => {
    const discovered = sanitizeSources(discovery.sources);
    const captured = monitor.capture === undefined ? discovered : await monitor.capture(discovered);
    const result = sanitizeSources(captured);
    const discoveredIds = new Set(discovered.map((source) => source.id));
    const capturedIds = new Set(result.map((source) => source.id));
    if (
      discoveredIds.size !== capturedIds.size ||
      [...discoveredIds].some((id) => !capturedIds.has(id))
    ) {
      throw new Error('source-capture-cohort-mismatch');
    }
    const discoveryById = new Map(discovered.map((source) => [source.id, source]));
    for (const source of result) {
      const original = discoveryById.get(source.id);
      if (
        original === undefined ||
        original.nativeSessionId !== source.nativeSessionId ||
        original.legacySessionId !== source.legacySessionId ||
        original.title !== source.title ||
        original.updatedAt !== source.updatedAt ||
        original.isTopLevel !== source.isTopLevel ||
        original.isArchived !== source.isArchived
      ) {
        throw new Error('source-capture-metadata-mismatch');
      }
    }
    return result;
  };

  const migrateCodexThreadIds = async (
    runtime: SurfaceRuntime,
    expectedGeneration: number,
    expectedSurfaceGeneration: number,
  ): Promise<void> => {
    if (!runtime.key.startsWith('codex:')) return;
    const aliases = new Map<string, string[]>();
    const currentIds = new Set(
      runtime.sources.map((source) => makeSessionId('codex', source.nativeSessionId)),
    );
    for (const source of runtime.sources) {
      if (source.legacySessionId === undefined) continue;
      const oldId = makeSessionId('codex', source.legacySessionId);
      const newId = makeSessionId('codex', source.nativeSessionId);
      aliases.set(oldId, [...(aliases.get(oldId) ?? []), newId]);
    }
    if (aliases.size === 0) return;
    await withCommitLock(async () => {
      if (
        stopped ||
        expectedGeneration !== generation ||
        expectedSurfaceGeneration !== runtime.generation
      )
        return;
      const candidate = cloneMonitoringState(monitoring);
      const partition = candidate.partitions[runtime.key];
      const sessions = { ...partition.sessions };
      const replacements = new Map<string, string>();
      const removedIds = new Set<string>();
      let changed = false;
      for (const [oldId, targets] of aliases) {
        if (currentIds.has(oldId)) continue;
        const old = own(sessions, oldId);
        if (old === undefined) continue;
        const target = targets.length === 1 ? targets[0] : undefined;
        if (target !== undefined && own(sessions, target) === undefined) {
          sessions[target] = { ...old, id: target, nativeSessionId: target.slice('codex:'.length) };
          replacements.set(oldId, target);
        }
        delete sessions[oldId];
        removedIds.add(oldId);
        changed = true;
      }
      if (!changed) return;
      partition.sessions = sessions;
      const replaceOrder = (order: readonly string[]): string[] => [
        ...new Set(
          order
            .map((id) => replacements.get(id) ?? id)
            .filter((id) => own(sessions, id) !== undefined || !id.startsWith('codex:')),
        ),
      ];
      partition.order = replaceOrder(partition.order);
      const otherOwner = (id: string): SurfaceKey | undefined =>
        SURFACE_KEYS.find(
          (key) => key !== runtime.key && own(candidate.partitions[key].sessions, id) !== undefined,
        );
      candidate.globalOrder = [
        ...new Set(
          candidate.globalOrder.flatMap((id) =>
            removedIds.has(id)
              ? [replacements.get(id), otherOwner(id) === undefined ? undefined : id].filter(
                  (value): value is string => value !== undefined,
                )
              : [id],
          ),
        ),
      ];
      const owners = { ...candidate.owners };
      for (const oldId of removedIds) {
        const target = replacements.get(oldId);
        if (target !== undefined) owners[target] = runtime.key;
        if (owners[oldId] === runtime.key) {
          const replacementOwner = otherOwner(oldId);
          if (replacementOwner === undefined) delete owners[oldId];
          else owners[oldId] = replacementOwner;
        }
      }
      candidate.owners = owners;
      await saveAndPublish(
        candidate,
        expectedGeneration,
        () => expectedSurfaceGeneration === runtime.generation,
      );
    });
  };

  async function runSurface(
    runtime: SurfaceRuntime,
    expectedGeneration: number,
    expectedSurfaceGeneration: number,
    forceCatalog: boolean,
  ): Promise<void> {
    if (
      stopped ||
      suspended ||
      !started ||
      expectedGeneration !== generation ||
      runtime.busy ||
      !runtime.monitor ||
      !monitoring.partitions[runtime.key].enabled ||
      expectedSurfaceGeneration !== runtime.generation
    ) {
      return;
    }
    runtime.busy = true;
    const monitor = runtime.monitor;
    try {
      const needsCatalog = forceCatalog || now() - runtime.lastCatalogAt >= catalogPollIntervalMs;
      let capturedAt = now();
      let didCatalog = false;
      if (needsCatalog) {
        const discovery = await monitor.discover();
        if (
          expectedGeneration !== generation ||
          expectedSurfaceGeneration !== runtime.generation ||
          stopped ||
          suspended
        )
          return;
        if (!discovery.complete) throw new Error('catalog-incomplete');
        if (
          discovery.coverageIncomplete !== undefined &&
          typeof discovery.coverageIncomplete !== 'boolean'
        )
          throw new Error('invalid-catalog-coverage');
        runtime.sources = await captureSources(monitor, discovery);
        runtime.unavailableSourceIds.clear();
        await migrateCodexThreadIds(runtime, expectedGeneration, expectedSurfaceGeneration);
        runtime.coverageIncomplete ||= discovery.coverageIncomplete === true;
        if (
          monitoring.partitions[runtime.key].baseline.status === 'pending' &&
          runtime.sources.some((source) => source.endOffset === undefined)
        ) {
          throw new Error('baseline-cutoff-missing');
        }
        runtime.lastCatalogAt = now();
        didCatalog = true;
        capturedAt = validTimestamp(discovery.capturedAt)
          ? discovery.capturedAt
          : runtime.lastCatalogAt;
      }
      if (
        expectedGeneration !== generation ||
        expectedSurfaceGeneration !== runtime.generation ||
        stopped ||
        suspended
      )
        return;
      const partition = monitoring.partitions[runtime.key];
      const baseline = partition.baseline.status === 'pending';
      const [provider, surface] = [providerFromKey(runtime.key), surfaceFromKey(runtime.key)];
      let continuationState = partitionRecordState(partition, runtime.key);
      for (const source of runtime.sources) {
        continuationState = reduceSessionState(continuationState, {
          type: 'upsert',
          provider,
          surface,
          nativeSessionId: source.nativeSessionId,
          title: source.title,
          isTopLevel: source.isTopLevel,
          isArchived: source.isArchived,
          canOpen: false,
          updatedAt: source.updatedAt,
        });
      }
      let sourceStart = 0;
      const currentSourceIds = new Set(runtime.sources.map((source) => source.id));
      let cursors: SurfaceCursorMap = Object.fromEntries(
        Object.entries(partition.cursors).filter(([sourceId]) => currentSourceIds.has(sourceId)),
      );
      // A source discovered after the initial baseline must still replay only
      // to its captured EOF as historical work. This prevents old completion
      // events becoming unread when uncertain catalog metadata later resolves.
      const newlyObservedSourceIds = new Set(
        baseline
          ? []
          : runtime.sources
              .filter((source) => cursors[source.id] === undefined)
              .map((source) => source.id),
      );
      const newlyObservedSessionIds = new Set(
        runtime.sources
          .filter((source) => newlyObservedSourceIds.has(source.id))
          .map((source) => makeSessionId(provider, source.nativeSessionId)),
      );
      const frozenCutoffs = sourceCutoffs(runtime.sources, baseline, newlyObservedSourceIds);
      const events: (SessionEvent | RuntimeEventEnvelope)[] = [];
      const exhaustedSourceIds = new Set<string>();
      let readPasses = 0;
      let hasMore = true;
      let finalReadComplete = false;
      let totalEvents = 0;
      while (hasMore) {
        if (++readPasses > 4_096) throw new Error('read-continuation-overflow');
        const cursorsBeforeRead = JSON.stringify(cursors);
        const read = await monitor.read({
          sources: runtime.sources,
          cursors,
          sessions: continuationState.sessions,
          frozenCutoffs,
          baseline,
          ...(sourceStart === 0 ? {} : { sourceStart }),
        });
        if (
          expectedGeneration !== generation ||
          expectedSurfaceGeneration !== runtime.generation ||
          stopped ||
          suspended
        )
          return;
        if (!isRecord(read) || typeof read.complete !== 'boolean' || !Array.isArray(read.events)) {
          throw new Error('invalid-read-result');
        }
        if (read.coverageIncomplete !== undefined && typeof read.coverageIncomplete !== 'boolean') {
          throw new Error('invalid-read-coverage');
        }
        runtime.coverageIncomplete ||= read.coverageIncomplete === true;
        for (const sourceId of read.unavailableSourceIds ?? []) {
          if (!validSourceId(sourceId) || !runtime.sources.some((source) => source.id === sourceId))
            throw new Error('invalid-unavailable-source');
          runtime.unavailableSourceIds.add(sourceId);
        }
        if (read.events.length > MAX_RUNTIME_EVENTS_PER_READ) {
          throw new Error('read-event-overflow');
        }
        totalEvents += read.events.length;
        if (totalEvents > MAX_RUNTIME_EVENTS_PER_REPLAY) {
          throw new Error('read-replay-overflow');
        }
        cursors = mergeReadCursors(runtime.sources, cursors, read.cursors);
        const exhausted = read.exhaustedSourceIds ?? [];
        if (!Array.isArray(exhausted)) throw new Error('invalid-read-exhaustion');
        for (const sourceId of exhausted) {
          if (
            !validSourceId(sourceId) ||
            !runtime.sources.some((source) => source.id === sourceId)
          ) {
            throw new Error('invalid-read-exhaustion');
          }
          exhaustedSourceIds.add(sourceId);
        }
        for (const value of read.events) {
          const event = normalizeEnvelope(value, baseline, events.length);
          if (event === undefined) {
            events.push(value);
            continue;
          }
          if (safeEventForSurface(event.event, runtime.key)) {
            validateEventSource(event, runtime.sources);
            continuationState = reduceSessionState(continuationState, event.event);
          }
          const isNewSourceHistory =
            'sessionId' in event.event && newlyObservedSessionIds.has(event.event.sessionId);
          events.push({
            event: event.event,
            historical: event.historical || isNewSourceHistory,
            ...(event.sourceId === undefined ? {} : { sourceId: event.sourceId }),
          });
        }
        if (read.nextSourceIndex === undefined) {
          hasMore = false;
          finalReadComplete = read.complete;
          continue;
        }
        if (read.nextSourceIndex >= runtime.sources.length) {
          throw new Error('invalid-read-continuation');
        }
        if (
          read.nextSourceIndex < sourceStart ||
          (read.nextSourceIndex === sourceStart &&
            JSON.stringify(cursors) === cursorsBeforeRead &&
            read.events.length === 0)
        ) {
          throw new Error('invalid-read-continuation');
        }
        sourceStart = read.nextSourceIndex;
      }
      if (!finalReadComplete || !readComplete(runtime.sources, cursors, exhaustedSourceIds)) {
        throw new Error('read-incomplete');
      }
      await applyRead(
        runtime,
        runtime.sources,
        capturedAt,
        { events, cursors, complete: true, exhaustedSourceIds: [...exhaustedSourceIds] },
        expectedGeneration,
        expectedSurfaceGeneration,
        didCatalog,
      );
      if (
        expectedGeneration !== generation ||
        expectedSurfaceGeneration !== runtime.generation ||
        stopped ||
        suspended
      )
        return;
      runtime.retryMs = filePollIntervalMs;
      setHealth(runtime.key, 'available', undefined, runtime.coverageIncomplete);
      publish();
      scheduleSurface(runtime, filePollIntervalMs, expectedGeneration, expectedSurfaceGeneration);
    } catch {
      if (
        expectedGeneration !== generation ||
        expectedSurfaceGeneration !== runtime.generation ||
        stopped ||
        suspended
      )
        return;
      const delay = runtime.retryMs;
      runtime.retryMs = Math.min(maxRetryIntervalMs, Math.max(filePollIntervalMs, delay * 2));
      setHealth(runtime.key, 'error', delay);
      publish();
      scheduleSurface(runtime, delay, expectedGeneration, expectedSurfaceGeneration);
    } finally {
      runtime.busy = false;
    }
  }

  const launchSurfaceRead = (
    runtime: SurfaceRuntime,
    expectedGeneration: number,
    expectedSurfaceGeneration: number,
    forceCatalog: boolean,
  ): Promise<void> => {
    const task = runSurface(runtime, expectedGeneration, expectedSurfaceGeneration, forceCatalog);
    runtime.inFlight = task;
    void task.then(
      () => {
        if (runtime.inFlight === task) runtime.inFlight = undefined;
      },
      () => {
        if (runtime.inFlight === task) runtime.inFlight = undefined;
      },
    );
    return task;
  };

  const startSurface = async (
    runtime: SurfaceRuntime,
    expectedGeneration: number,
  ): Promise<void> => {
    if (!runtime.monitor || !monitoring.partitions[runtime.key].enabled) return;
    const expectedSurfaceGeneration = ++runtime.generation;
    setHealth(runtime.key, 'starting');
    const starting = Promise.resolve().then(() => runtime.monitor!.start());
    runtime.starting = starting;
    try {
      await starting;
    } catch {
      if (
        expectedGeneration !== generation ||
        expectedSurfaceGeneration !== runtime.generation ||
        stopped ||
        suspended
      )
        return;
      const delay = runtime.retryMs;
      runtime.retryMs = Math.min(maxRetryIntervalMs, Math.max(filePollIntervalMs, delay * 2));
      setHealth(runtime.key, 'error', delay);
      publish();
      clearTimer(runtime);
      const retryGeneration = runtime.generation;
      const retryGlobalGeneration = generation;
      runtime.timer = schedule(() => {
        runtime.timer = undefined;
        if (
          stopped ||
          suspended ||
          !started ||
          retryGlobalGeneration !== generation ||
          retryGeneration !== runtime.generation
        )
          return;
        void startSurface(runtime, retryGlobalGeneration);
      }, delay);
      return;
    } finally {
      if (runtime.starting === starting) runtime.starting = undefined;
    }
    if (
      expectedGeneration !== generation ||
      expectedSurfaceGeneration !== runtime.generation ||
      stopped ||
      suspended
    )
      return;
    await launchSurfaceRead(runtime, expectedGeneration, expectedSurfaceGeneration, true);
  };

  const stopSurface = async (runtime: SurfaceRuntime): Promise<void> => {
    runtime.generation += 1;
    const stoppingGeneration = runtime.generation;
    clearTimer(runtime);
    runtime.sources = [];
    runtime.unavailableSourceIds.clear();
    runtime.coverageIncomplete = false;
    runtime.lastCatalogAt = 0;
    runtime.retryMs = filePollIntervalMs;
    if (runtime.starting !== undefined) await runtime.starting.catch(() => undefined);
    if (runtime.monitor) await Promise.resolve(runtime.monitor.stop()).catch(() => undefined);
    if (runtime.inFlight !== undefined) await runtime.inFlight.catch(() => undefined);
    if (runtime.generation === stoppingGeneration) setHealth(runtime.key, 'stopped');
  };

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    if (loadPromise === undefined) loadPromise = loadSessionState(options.appDataPath);
    const restored = await loadPromise;
    if (stopped || loaded) return;
    monitoring = restored.monitoring;
    loaded = true;
    // The overlay's reduced-motion preference is owned by DesktopPreferences;
    // the runtime never persists or invents it.
    publish();
  };

  const updateSession = async (event: SessionEvent): Promise<boolean> => {
    if (
      stopped ||
      !isSessionEvent(event) ||
      event.type === 'upsert' ||
      event.type === 'provider-health'
    ) {
      return false;
    }
    await ensureLoaded();
    if (stopped) return false;
    return withCommitLock(async () => {
      const explicitOwner = own(monitoring.owners, event.sessionId);
      const eligible = (key: SurfaceKey): boolean =>
        monitoring.partitions[key].enabled &&
        monitoring.partitions[key].baseline.status === 'ready' &&
        own(monitoring.partitions[key].sessions, event.sessionId) !== undefined;
      const owner =
        explicitOwner !== undefined && eligible(explicitOwner)
          ? explicitOwner
          : SURFACE_KEYS.find(eligible);
      if (owner === undefined) return false;
      const candidate = cloneMonitoringState(monitoring);
      const partition = candidate.partitions[owner];
      const previous = partitionRecordState(partition, owner);
      const next = reduceSessionState(previous, event);
      if (next === previous) return false;
      partition.sessions = { ...next.sessions };
      partition.order = [...next.order];
      candidate.globalOrder = globalOrderWith(
        candidate,
        owner,
        partition,
        event.type === 'turn-started' ? [event.sessionId] : [],
      );
      enforceRetentionCap(candidate);
      await saveAndPublish(candidate, generation);
      return true;
    });
  };

  const coordinator: RuntimeCoordinator = {
    start: async (): Promise<void> => {
      if (stopped || started) return;
      started = true;
      await ensureLoaded();
      if (stopped) return;
      const expectedGeneration = ++generation;
      await Promise.all(
        [...surfaces.values()]
          .filter((runtime) => runtime.monitor && monitoring.partitions[runtime.key].enabled)
          .map((runtime) => startSurface(runtime, expectedGeneration)),
      );
    },
    suspend: async (): Promise<void> => {
      if (stopped || !started || suspended) return;
      suspended = true;
      generation += 1;
      await Promise.all([...surfaces.values()].map((runtime) => stopSurface(runtime)));
      publish();
    },
    resume: async (): Promise<void> => {
      if (stopped || !started || !suspended) return;
      suspended = false;
      const expectedGeneration = ++generation;
      await Promise.all(
        [...surfaces.values()]
          .filter((runtime) => runtime.monitor && monitoring.partitions[runtime.key].enabled)
          .map((runtime) => startSurface(runtime, expectedGeneration)),
      );
    },
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      started = false;
      generation += 1;
      await Promise.all([...surfaces.values()].map((runtime) => stopSurface(runtime)));
    },
    shutdown: async (): Promise<void> => {
      await coordinator.stop();
    },
    connect: async (provider, surface): Promise<void> => {
      if (stopped) return;
      await ensureLoaded();
      if (stopped) return;
      const key = surfaceKey(provider, surface);
      const runtime = surfaces.get(key);
      const wasEnabled = monitoring.partitions[key].enabled;
      if (runtime) await stopSurface(runtime);
      const stoppedGeneration = runtime?.generation;
      try {
        await withCommitLock(async () => {
          const candidate = connectMonitoringSurface(monitoring, provider, surface);
          candidate.partitions[key].legacyRetained = false;
          await saveSessionState(options.appDataPath, candidate);
          if (stopped) return;
          monitoring = candidate;
          publish();
        });
      } catch (error) {
        if (
          runtime &&
          started &&
          !suspended &&
          !stopped &&
          wasEnabled &&
          runtime.generation === stoppedGeneration &&
          monitoring.partitions[key].enabled
        ) {
          await startSurface(runtime, generation);
        }
        throw error;
      }
      if (
        runtime &&
        started &&
        !suspended &&
        runtime.generation === stoppedGeneration &&
        monitoring.partitions[key].enabled
      ) {
        const expectedGeneration = generation;
        await startSurface(runtime, expectedGeneration);
      }
    },
    disconnect: async (provider, surface): Promise<void> => {
      if (stopped) return;
      await ensureLoaded();
      if (stopped) return;
      const key = surfaceKey(provider, surface);
      const runtime = surfaces.get(key);
      if (runtime) await stopSurface(runtime);
      const stoppedGeneration = runtime?.generation;
      try {
        await withCommitLock(async () => {
          const candidate = disconnectMonitoringSurface(monitoring, provider, surface);
          await saveSessionState(options.appDataPath, candidate);
          if (stopped) return;
          monitoring = candidate;
          publish();
        });
      } catch (error) {
        // The checkpoint failed, so the prior enabled state is still the
        // source of truth. Restore its monitor before surfacing the failure.
        if (
          runtime &&
          started &&
          !suspended &&
          !stopped &&
          runtime.generation === stoppedGeneration &&
          monitoring.partitions[key].enabled
        ) {
          await startSurface(runtime, generation);
        }
        throw error;
      }
    },
    acknowledge: async (sessionId, completionId): Promise<boolean> =>
      updateSession({
        type: 'acknowledged',
        sessionId,
        expectedCompletionId: completionId,
        timestamp: now(),
      }),
    dismissError: async (sessionId): Promise<boolean> =>
      updateSession({ type: 'dismissed-error', sessionId, timestamp: now() }),
    getMonitoringState: (): MonitoringState => cloneMonitoringState(monitoring),
    getHealth: (): Readonly<Record<SurfaceKey, RuntimeSurfaceHealth>> => cloneHealth(health),
    getOverlayState: (): OverlayState => ({
      sessions: [...overlay.sessions],
      reducedMotion: overlay.reducedMotion,
    }),
    getCoverageWarning: (): string | undefined => coverageWarning,
    setRecentThreadLimit: (limit): void => {
      if (!isRecentThreadLimit(limit)) throw new Error('Invalid recent thread limit');
      recentThreadLimit = limit;
      publish();
    },
  };

  return coordinator;
}

export const createProviderRuntimeCoordinator = createRuntimeCoordinator;
export type Monitor = ProviderSurfaceMonitor;

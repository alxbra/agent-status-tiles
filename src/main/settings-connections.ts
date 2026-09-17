import { surfaceKey, type SurfaceKey } from '../shared/monitoring';
import type { Provider, Surface } from '../shared/session';
import {
  SETTINGS_CONNECTION_LABELS,
  type SettingsConnectionKey,
  type SettingsProviderState,
} from '../shared/settings';
import type { RuntimeCoordinator } from './runtime/coordinator';

/** The coordinator surface the Settings connection rules need; tests inject a fake. */
export type ConnectionCoordinator = Pick<
  RuntimeCoordinator,
  'getMonitoringState' | 'getHealth' | 'connect' | 'disconnect'
>;

/**
 * Provider-specific setup that runs around the partition changes. Claude
 * installs its hooks before its surfaces are enabled and removes them after
 * they are disabled; Codex needs nothing beyond its monitors.
 */
export interface ProviderSetup {
  /** Install or refresh the provider's integration; throws when it cannot. */
  install?: () => Promise<void>;
  /** Remove only this app's integration entries; throws when it cannot. */
  remove?: () => Promise<void>;
  /** A provider-specific issue sentence that beats the generic health sentence. */
  issue?: () => string | undefined;
}

export type ProviderSetupMap = Readonly<Partial<Record<SettingsConnectionKey, ProviderSetup>>>;

/**
 * One Settings row per provider. Connecting a row enables every surface behind
 * it; each surface still keeps its own partition, baseline, cursors, and health.
 */
const CONNECTION_TARGETS: Readonly<
  Record<SettingsConnectionKey, readonly (readonly [Provider, Surface])[]>
> = {
  codex: [
    ['codex', 'desktop'],
    ['codex', 'cli'],
  ],
  claude: [
    ['claude', 'desktop'],
    ['claude', 'cli'],
  ],
};

/** Rows that can be connected from Settings. */
export const CONNECTABLE_CONNECTIONS: readonly SettingsConnectionKey[] = ['codex', 'claude'];

export function isConnectable(connection: SettingsConnectionKey): boolean {
  return CONNECTABLE_CONNECTIONS.includes(connection);
}

function surfaceKeysFor(connection: SettingsConnectionKey): readonly SurfaceKey[] {
  return CONNECTION_TARGETS[connection].map(([provider, surface]) => surfaceKey(provider, surface));
}

export function enabledSurfaceKeysFor(
  coordinator: ConnectionCoordinator,
  connection: SettingsConnectionKey,
): readonly SurfaceKey[] {
  const partitions = coordinator.getMonitoringState().partitions;
  return surfaceKeysFor(connection).filter((key) => partitions[key].enabled);
}

export function isFullyEnabled(
  coordinator: ConnectionCoordinator,
  connection: SettingsConnectionKey,
): boolean {
  return (
    enabledSurfaceKeysFor(coordinator, connection).length === surfaceKeysFor(connection).length
  );
}

export function connectionState(
  coordinator: ConnectionCoordinator | null,
  connection: SettingsConnectionKey,
): SettingsProviderState {
  if (coordinator === null)
    return { status: 'unavailable', canConnect: false, canDisconnect: false };
  const enabledKeys = enabledSurfaceKeysFor(coordinator, connection);
  const canConnect = isConnectable(connection);
  if (enabledKeys.length === 0) {
    return {
      status: canConnect ? 'disconnected' : 'unavailable',
      canConnect,
      canDisconnect: false,
    };
  }
  // The row is connected when any of its surfaces is monitoring; a surface
  // whose installation is absent stays quietly unavailable behind it.
  const statuses = enabledKeys.map((key) => coordinator.getHealth()[key].status);
  return {
    status: statuses.includes('available')
      ? 'connected'
      : statuses.includes('starting')
        ? 'connecting'
        : 'unavailable',
    canConnect: false,
    canDisconnect: true,
  };
}

/** One actionable sentence, or nothing while the row is healthy or still starting. */
export function connectionIssue(
  coordinator: ConnectionCoordinator | null,
  connection: SettingsConnectionKey,
  setup?: ProviderSetup,
): string | undefined {
  if (coordinator === null) return undefined;
  const enabledKeys = enabledSurfaceKeysFor(coordinator, connection);
  if (enabledKeys.length === 0) return undefined;
  const statuses = enabledKeys.map((key) => coordinator.getHealth()[key].status);
  const label = SETTINGS_CONNECTION_LABELS[connection];
  const hasError = statuses.includes('error');
  const allMissing = statuses.every((status) => status === 'unavailable');
  if (!hasError && !allMissing) return undefined;
  // A provider that knows exactly why a surface errored says so instead of
  // the generic sentence; a quietly missing installation is not its business.
  const specific = hasError ? setup?.issue?.() : undefined;
  if (specific !== undefined) return specific;
  // Partial catalog coverage is not a connection failure, and one surface that
  // is simply not installed is not an error while another surface monitors.
  if (hasError) {
    return `${label} connection failed. Check the installation, then disconnect and reconnect.`;
  }
  // A missing installation is re-checked by the coordinator on its own, so
  // installing it is the only action the user needs to take.
  return `${label} was not found. Install it to connect.`;
}

/**
 * Enable every surface behind a provider row that is not yet enabled. If a
 * later surface's checkpoint fails, the surfaces enabled by this call are
 * disabled again so the row never ends up half-connected by accident.
 */
export async function connectProviderSurfaces(
  coordinator: ConnectionCoordinator,
  connection: SettingsConnectionKey,
): Promise<void> {
  const partitions = coordinator.getMonitoringState().partitions;
  const missing = CONNECTION_TARGETS[connection].filter(
    ([provider, surface]) => !partitions[surfaceKey(provider, surface)].enabled,
  );
  const enabledHere: (readonly [Provider, Surface])[] = [];
  for (const [provider, surface] of missing) {
    try {
      await coordinator.connect(provider, surface);
      enabledHere.push([provider, surface]);
    } catch (error) {
      for (const [rollbackProvider, rollbackSurface] of [...enabledHere].reverse()) {
        await coordinator.disconnect(rollbackProvider, rollbackSurface).catch(() => undefined);
      }
      throw error;
    }
  }
}

/**
 * Disable every enabled surface behind a provider row. Every surface is
 * attempted; the first failure is rethrown afterwards.
 */
export async function disconnectProviderSurfaces(
  coordinator: ConnectionCoordinator,
  connection: SettingsConnectionKey,
): Promise<void> {
  let firstFailure: { error: unknown } | undefined;
  for (const [provider, surface] of CONNECTION_TARGETS[connection]) {
    if (!coordinator.getMonitoringState().partitions[surfaceKey(provider, surface)].enabled)
      continue;
    try {
      await coordinator.disconnect(provider, surface);
    } catch (error) {
      firstFailure ??= { error };
    }
  }
  if (firstFailure !== undefined) throw firstFailure.error;
}

/**
 * Install the provider's integration first, then enable its surfaces. When
 * enabling fails after a successful install, the integration is removed
 * again: a disconnected row has no Disconnect to clean it up with.
 */
export async function connectProvider(
  coordinator: ConnectionCoordinator,
  connection: SettingsConnectionKey,
  setup?: ProviderSetup,
): Promise<void> {
  await setup?.install?.();
  try {
    await connectProviderSurfaces(coordinator, connection);
  } catch (error) {
    try {
      await setup?.remove?.();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Provider connection failed and its integration could not be removed',
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/**
 * Disable the provider's surfaces, then remove its integration entries. The
 * removal runs even when a surface failed to disable, and the first failure
 * is reported afterwards, so a half-disconnected row never keeps live hooks.
 */
export async function disconnectProvider(
  coordinator: ConnectionCoordinator,
  connection: SettingsConnectionKey,
  setup?: ProviderSetup,
): Promise<void> {
  let firstFailure: { error: unknown } | undefined;
  try {
    await disconnectProviderSurfaces(coordinator, connection);
  } catch (error) {
    firstFailure = { error };
  }
  try {
    await setup?.remove?.();
  } catch (error) {
    firstFailure ??= { error };
  }
  if (firstFailure !== undefined) throw firstFailure.error;
}

/**
 * Refresh the integration and restart every enabled surface. A restart goes
 * through the coordinator's connect, which re-baselines the surface so
 * nothing historical turns unread.
 */
export async function repairProvider(
  coordinator: ConnectionCoordinator,
  connection: SettingsConnectionKey,
  setup?: ProviderSetup,
): Promise<void> {
  await setup?.install?.();
  for (const [provider, surface] of CONNECTION_TARGETS[connection]) {
    if (!coordinator.getMonitoringState().partitions[surfaceKey(provider, surface)].enabled)
      continue;
    await coordinator.connect(provider, surface);
  }
}

/**
 * A checkpoint written before surfaces were bundled may have only one Codex
 * surface enabled. That connection now means both surfaces, so enable the
 * rest through the normal pending baseline; a missing installation stays
 * quietly unavailable, and nothing historical is shown as unread. A fully
 * enabled or fully disabled row is left alone, so repeated launches are
 * idempotent. Settings IPC actions wait on the runtime start promise that
 * includes this step, so no user action can interleave with it.
 */
export async function completeProviderBundles(coordinator: ConnectionCoordinator): Promise<void> {
  // A partially enabled row was connected through its setup once, so the
  // missing surface only needs its partition; no provider setup runs here.
  for (const connection of CONNECTABLE_CONNECTIONS) {
    const enabledCount = enabledSurfaceKeysFor(coordinator, connection).length;
    if (enabledCount === 0 || enabledCount === surfaceKeysFor(connection).length) continue;
    try {
      await connectProviderSurfaces(coordinator, connection);
    } catch {
      // The partial bundle keeps working; the next launch retries.
    }
  }
}

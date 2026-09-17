import { describe, expect, it, vi } from 'vitest';

import { createInitialMonitoringState } from '../../src/main/sessions/persistence';
import {
  completeProviderBundles,
  connectProviderSurfaces,
  connectionIssue,
  connectionState,
  disconnectProviderSurfaces,
  type ConnectionCoordinator,
} from '../../src/main/settings-connections';
import type { RuntimeHealthStatus, RuntimeSurfaceHealth } from '../../src/main/runtime/coordinator';
import { SURFACE_KEYS, type SurfaceKey } from '../../src/shared/monitoring';
import type { Provider, Surface } from '../../src/shared/session';

interface FakeCoordinator extends ConnectionCoordinator {
  enabled: Set<SurfaceKey>;
  health: Partial<Record<SurfaceKey, RuntimeHealthStatus>>;
  connect: ReturnType<typeof vi.fn<(provider: Provider, surface: Surface) => Promise<void>>>;
  disconnect: ReturnType<typeof vi.fn<(provider: Provider, surface: Surface) => Promise<void>>>;
}

function fakeCoordinator(
  enabled: readonly SurfaceKey[] = [],
  health: Partial<Record<SurfaceKey, RuntimeHealthStatus>> = {},
): FakeCoordinator {
  const coordinator: FakeCoordinator = {
    enabled: new Set(enabled),
    health,
    getMonitoringState: () => {
      const state = createInitialMonitoringState();
      for (const key of coordinator.enabled) state.partitions[key].enabled = true;
      return state;
    },
    getHealth: () => {
      const result = {} as Record<SurfaceKey, RuntimeSurfaceHealth>;
      for (const key of SURFACE_KEYS) {
        result[key] = { status: coordinator.health[key] ?? 'stopped', updatedAt: 1 };
      }
      return result;
    },
    connect: vi.fn(async (provider: Provider, surface: Surface) => {
      coordinator.enabled.add(`${provider}:${surface}`);
    }),
    disconnect: vi.fn(async (provider: Provider, surface: Surface) => {
      coordinator.enabled.delete(`${provider}:${surface}`);
    }),
  };
  return coordinator;
}

describe('settings connections', () => {
  it('derives one row state per provider from its surfaces', () => {
    expect(connectionState(null, 'codex')).toEqual({
      status: 'unavailable',
      canConnect: false,
      canDisconnect: false,
    });
    const disconnected = fakeCoordinator();
    expect(connectionState(disconnected, 'codex')).toEqual({
      status: 'disconnected',
      canConnect: true,
      canDisconnect: false,
    });
    // Claude has no live monitors yet, so its row is not connectable.
    expect(connectionState(disconnected, 'claude')).toEqual({
      status: 'unavailable',
      canConnect: false,
      canDisconnect: false,
    });

    const desktopOnly = fakeCoordinator(['codex:desktop', 'codex:cli'], {
      'codex:desktop': 'available',
      'codex:cli': 'unavailable',
    });
    expect(connectionState(desktopOnly, 'codex')).toMatchObject({
      status: 'connected',
      canDisconnect: true,
    });
    expect(connectionIssue(desktopOnly, 'codex')).toBeUndefined();

    const starting = fakeCoordinator(['codex:desktop', 'codex:cli'], {
      'codex:desktop': 'starting',
      'codex:cli': 'unavailable',
    });
    expect(connectionState(starting, 'codex').status).toBe('connecting');
    expect(connectionIssue(starting, 'codex')).toBeUndefined();
  });

  it('shows one sentence only for an errored surface or a fully missing provider', () => {
    const errored = fakeCoordinator(['codex:desktop', 'codex:cli'], {
      'codex:desktop': 'error',
      'codex:cli': 'available',
    });
    expect(connectionState(errored, 'codex').status).toBe('connected');
    expect(connectionIssue(errored, 'codex')).toBe(
      'Codex connection failed. Check the installation, then disconnect and reconnect.',
    );

    const missing = fakeCoordinator(['codex:desktop', 'codex:cli'], {
      'codex:desktop': 'unavailable',
      'codex:cli': 'unavailable',
    });
    expect(connectionState(missing, 'codex')).toMatchObject({
      status: 'unavailable',
      canDisconnect: true,
    });
    expect(connectionIssue(missing, 'codex')).toBe('Codex was not found. Install it to connect.');

    expect(connectionIssue(fakeCoordinator(), 'codex')).toBeUndefined();
    expect(connectionIssue(null, 'codex')).toBeUndefined();
    for (const issue of [connectionIssue(errored, 'codex'), connectionIssue(missing, 'codex')]) {
      expect(issue).not.toMatch(/\/|path|prompt|transcript/u);
    }
  });

  it('connects only the missing surfaces and rolls back when a later one fails', async () => {
    const partial = fakeCoordinator(['codex:desktop']);
    await connectProviderSurfaces(partial, 'codex');
    expect(partial.connect.mock.calls).toEqual([['codex', 'cli']]);
    expect([...partial.enabled].sort()).toEqual(['codex:cli', 'codex:desktop']);

    const failing = fakeCoordinator();
    failing.connect.mockImplementationOnce(async (provider, surface) => {
      failing.enabled.add(`${provider}:${surface}`);
    });
    failing.connect.mockImplementationOnce(async () => {
      throw new Error('checkpoint failed');
    });
    await expect(connectProviderSurfaces(failing, 'codex')).rejects.toThrow('checkpoint failed');
    expect(failing.disconnect.mock.calls).toEqual([['codex', 'desktop']]);
    expect(failing.enabled.size).toBe(0);
  });

  it('disconnects every enabled surface and rethrows the first failure afterwards', async () => {
    const both = fakeCoordinator(['codex:desktop', 'codex:cli']);
    both.disconnect.mockImplementationOnce(async () => {
      throw new Error('desktop checkpoint failed');
    });
    await expect(disconnectProviderSurfaces(both, 'codex')).rejects.toThrow(
      'desktop checkpoint failed',
    );
    expect(both.disconnect.mock.calls).toEqual([
      ['codex', 'desktop'],
      ['codex', 'cli'],
    ]);
    expect([...both.enabled]).toEqual(['codex:desktop']);

    const cliOnly = fakeCoordinator(['codex:cli']);
    await disconnectProviderSurfaces(cliOnly, 'codex');
    expect(cliOnly.disconnect.mock.calls).toEqual([['codex', 'cli']]);
  });

  it('completes a partial bundle at launch, leaves other rows alone, and is idempotent', async () => {
    const partial = fakeCoordinator(['codex:cli']);
    await completeProviderBundles(partial);
    expect(partial.connect.mock.calls).toEqual([['codex', 'desktop']]);
    await completeProviderBundles(partial);
    expect(partial.connect).toHaveBeenCalledTimes(1);

    const untouched = fakeCoordinator(['claude:desktop']);
    await completeProviderBundles(untouched);
    expect(untouched.connect).not.toHaveBeenCalled();
    await completeProviderBundles(fakeCoordinator());

    const failing = fakeCoordinator(['codex:desktop']);
    failing.connect.mockImplementationOnce(async () => {
      throw new Error('checkpoint failed');
    });
    await expect(completeProviderBundles(failing)).resolves.toBeUndefined();
    expect([...failing.enabled]).toEqual(['codex:desktop']);
  });
});

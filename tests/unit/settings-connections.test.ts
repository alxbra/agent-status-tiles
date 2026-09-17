import { describe, expect, it, vi } from 'vitest';

import { createInitialMonitoringState } from '../../src/main/sessions/persistence';
import {
  completeProviderBundles,
  connectProvider,
  connectProviderSurfaces,
  connectionIssue,
  connectionState,
  disconnectProvider,
  disconnectProviderSurfaces,
  repairProvider,
  type ConnectionCoordinator,
  type ProviderSetup,
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
    expect(connectionState(disconnected, 'claude')).toEqual({
      status: 'disconnected',
      canConnect: true,
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

    const claudePartial = fakeCoordinator(['claude:desktop']);
    await completeProviderBundles(claudePartial);
    expect(claudePartial.connect.mock.calls).toEqual([['claude', 'cli']]);
    await completeProviderBundles(fakeCoordinator());

    const failing = fakeCoordinator(['codex:desktop']);
    failing.connect.mockImplementationOnce(async () => {
      throw new Error('checkpoint failed');
    });
    await expect(completeProviderBundles(failing)).resolves.toBeUndefined();
    expect([...failing.enabled]).toEqual(['codex:desktop']);
  });

  it('installs the integration before enabling surfaces and enables nothing when it fails', async () => {
    const order: string[] = [];
    const coordinator = fakeCoordinator();
    coordinator.connect.mockImplementation(async (provider, surface) => {
      order.push(`connect:${provider}:${surface}`);
      coordinator.enabled.add(`${provider}:${surface}`);
    });
    const setup: ProviderSetup = {
      install: vi.fn(async () => {
        order.push('install');
      }),
      remove: vi.fn(async () => {
        order.push('remove');
      }),
    };
    await connectProvider(coordinator, 'claude', setup);
    expect(order).toEqual(['install', 'connect:claude:desktop', 'connect:claude:cli']);

    const failing = fakeCoordinator();
    await expect(
      connectProvider(failing, 'claude', {
        install: async () => {
          throw new Error('settings-unwritable');
        },
      }),
    ).rejects.toThrow('settings-unwritable');
    expect(failing.connect).not.toHaveBeenCalled();
    expect(failing.enabled.size).toBe(0);

    // A checkpoint failure after a successful install removes the hooks again,
    // because a disconnected row offers no Disconnect to clean them up with.
    const checkpoint = fakeCoordinator();
    checkpoint.connect.mockImplementationOnce(async () => {
      throw new Error('checkpoint failed');
    });
    const remove = vi.fn(async () => undefined);
    await expect(
      connectProvider(checkpoint, 'claude', { install: async () => undefined, remove }),
    ).rejects.toThrow('checkpoint failed');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(checkpoint.enabled.size).toBe(0);

    const doubleFailure = fakeCoordinator();
    doubleFailure.connect.mockImplementationOnce(async () => {
      throw new Error('checkpoint failed');
    });
    await expect(
      connectProvider(doubleFailure, 'claude', {
        install: async () => undefined,
        remove: async () => {
          throw new Error('settings-unwritable');
        },
      }),
    ).rejects.toMatchObject({
      errors: [expect.any(Error), expect.any(Error)],
    });
  });

  it('disconnects surfaces first and still removes the integration when one surface fails', async () => {
    const order: string[] = [];
    const coordinator = fakeCoordinator(['claude:desktop', 'claude:cli']);
    coordinator.disconnect.mockImplementation(async (provider, surface) => {
      order.push(`disconnect:${provider}:${surface}`);
      if (surface === 'desktop') throw new Error('checkpoint failed');
      coordinator.enabled.delete(`${provider}:${surface}`);
    });
    const remove = vi.fn(async () => {
      order.push('remove');
    });
    await expect(disconnectProvider(coordinator, 'claude', { remove })).rejects.toThrow(
      'checkpoint failed',
    );
    expect(order).toEqual(['disconnect:claude:desktop', 'disconnect:claude:cli', 'remove']);

    const clean = fakeCoordinator(['claude:desktop', 'claude:cli']);
    await expect(
      disconnectProvider(clean, 'claude', {
        remove: async () => {
          throw new Error('settings-changed');
        },
      }),
    ).rejects.toThrow('settings-changed');
    expect(clean.enabled.size).toBe(0);
  });

  it('repairs by reinstalling and restarting only the enabled surfaces', async () => {
    const coordinator = fakeCoordinator(['claude:desktop']);
    const install = vi.fn(async () => undefined);
    await repairProvider(coordinator, 'claude', { install });
    expect(install).toHaveBeenCalledTimes(1);
    expect(coordinator.connect.mock.calls).toEqual([['claude', 'desktop']]);
    expect(coordinator.disconnect).not.toHaveBeenCalled();

    const codex = fakeCoordinator(['codex:desktop', 'codex:cli']);
    await repairProvider(codex, 'codex');
    expect(codex.connect.mock.calls).toEqual([
      ['codex', 'desktop'],
      ['codex', 'cli'],
    ]);
  });

  it('prefers the provider-specific issue sentence when a surface fails', () => {
    const errored = fakeCoordinator(['claude:desktop', 'claude:cli'], {
      'claude:desktop': 'error',
      'claude:cli': 'error',
    });
    const setup: ProviderSetup = {
      issue: () => 'Claude Code hooks are not installed. Use Repair to install them.',
    };
    expect(connectionIssue(errored, 'claude', setup)).toBe(
      'Claude Code hooks are not installed. Use Repair to install them.',
    );
    expect(connectionIssue(errored, 'claude', { issue: () => undefined })).toBe(
      'Claude Code connection failed. Check the installation, then disconnect and reconnect.',
    );
    const healthy = fakeCoordinator(['claude:desktop', 'claude:cli'], {
      'claude:desktop': 'available',
      'claude:cli': 'available',
    });
    // A stale issue from an earlier failure never shows while the row is healthy,
    // and a quietly missing installation keeps the generic sentence.
    expect(connectionIssue(healthy, 'claude', setup)).toBeUndefined();
    const missing = fakeCoordinator(['claude:desktop', 'claude:cli'], {
      'claude:desktop': 'unavailable',
      'claude:cli': 'unavailable',
    });
    expect(connectionIssue(missing, 'claude', setup)).toBe(
      'Claude Code was not found. Install it to connect.',
    );
  });
});

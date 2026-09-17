import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CATALOG_POLL_INTERVAL_MS,
  DEFAULT_FILE_POLL_INTERVAL_MS,
  createRuntimeCoordinator,
  type ProviderSurfaceMonitor,
  type RuntimeMonitorSource,
  type RuntimeReadRequest,
} from '../../src/main/runtime/coordinator';
import {
  createInitialMonitoringState,
  loadSessionState,
  saveSessionState,
} from '../../src/main/sessions/persistence';
import { MonitorPrerequisiteError } from '../../src/main/runtime/monitor-errors';
import { reduceSessionState } from '../../src/main/sessions/reducer';
import { createInitialSessionState, makeSessionId } from '../../src/shared/session';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appDataPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-runtime-'));
  roots.push(root);
  return root;
}

function source(nativeSessionId: string, index = 1): RuntimeMonitorSource {
  return {
    id: `source-${nativeSessionId}`,
    nativeSessionId,
    title: `Fixture ${index}`,
    updatedAt: index,
    isTopLevel: true,
    isArchived: false,
    endOffset: index * 10,
  };
}

function monitor(
  key: ProviderSurfaceMonitor['key'],
  sources: readonly RuntimeMonitorSource[],
  read: ProviderSurfaceMonitor['read'],
): ProviderSurfaceMonitor {
  return {
    key,
    start: vi.fn(),
    stop: vi.fn(),
    discover: vi.fn(async () => ({ complete: true, capturedAt: 100, sources })),
    capture: vi.fn(async (discovered) => discovered),
    read,
  };
}

describe('runtime coordinator', () => {
  it('keeps healthy threads available when another confirmed rollout is unreadable', async () => {
    const dataPath = await appDataPath();
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [
        monitor('codex:desktop', [source('good', 2), source('bad', 1)], async (request) => ({
          events: [],
          cursors: Object.fromEntries(
            request.sources.map((item) => [
              item.id,
              { identity: 'fixture', offset: item.endOffset ?? 0 },
            ]),
          ),
          complete: true,
          unavailableSourceIds: ['source-bad'],
        })),
      ],
    });
    try {
      await runtime.start();
      await runtime.connect('codex', 'desktop');
      expect(runtime.getOverlayState().sessions.map((item) => [item.id, item.status])).toEqual([
        ['codex:good', 'idle'],
        ['codex:bad', 'unavailable'],
      ]);
      expect(runtime.getHealth()['codex:desktop'].status).toBe('available');
    } finally {
      await runtime.stop();
    }
  });

  it('shows five latest top-level records across connected providers and changes the global limit', async () => {
    const dataPath = await appDataPath();
    const read = async (request: RuntimeReadRequest) => ({
      events: [],
      cursors: Object.fromEntries(
        request.sources.map((item) => [
          item.id,
          { identity: 'fixture', offset: item.endOffset ?? 0 },
        ]),
      ),
      complete: true,
    });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [
        monitor('codex:desktop', [source('d1', 1), source('d7', 7), source('d3', 3)], read),
        monitor('codex:cli', [source('c6', 6), source('c2', 2)], read),
        monitor('claude:desktop', [source('a5', 5), source('a4', 4)], read),
      ],
    });
    await runtime.start();
    await runtime.connect('codex', 'desktop');
    await runtime.connect('codex', 'cli');
    await runtime.connect('claude', 'desktop');
    expect(runtime.getOverlayState().sessions.map((item) => item.id)).toEqual([
      'codex:d7',
      'codex:c6',
      'claude:a5',
      'claude:a4',
      'codex:d3',
    ]);
    runtime.setRecentThreadLimit(2);
    expect(runtime.getOverlayState().sessions.map((item) => item.id)).toEqual([
      'codex:d7',
      'codex:c6',
    ]);
    expect(() => runtime.setRecentThreadLimit(11)).toThrow();
    await runtime.stop();
  });

  it('migrates an unambiguous saved Codex session record to the catalog thread ID', async () => {
    const dataPath = await appDataPath();
    const oldId = 'codex:rollout-id';
    const nextId = 'codex:thread-id';
    const oldState = reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'codex',
      surface: 'desktop',
      nativeSessionId: 'rollout-id',
      title: 'Old title',
      isTopLevel: true,
      isArchived: false,
      canOpen: false,
      updatedAt: 1,
    });
    const saved = createInitialMonitoringState();
    const partition = saved.partitions['codex:desktop'];
    partition.enabled = true;
    partition.baseline = { status: 'ready', cutoff: 2 };
    partition.sessions = oldState.sessions;
    partition.order = [oldId];
    partition.cursors = { 'source-thread-id': { identity: 'fixture', offset: 10 } };
    saved.globalOrder = [oldId];
    saved.owners = { [oldId]: 'codex:desktop' };
    await saveSessionState(dataPath, saved);
    const thread = { ...source('thread-id'), legacySessionId: 'rollout-id' };
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [
        monitor('codex:desktop', [thread], async (request) => ({
          events: [],
          cursors: request.cursors,
          complete: true,
        })),
      ],
    });
    await runtime.start();
    await vi.waitFor(() =>
      expect(
        runtime.getMonitoringState().partitions['codex:desktop'].sessions[nextId],
      ).toBeDefined(),
    );
    const migrated = (await loadSessionState(dataPath)).monitoring;
    expect(migrated.partitions['codex:desktop'].sessions[nextId]?.title).toBe('Fixture 1');
    expect(migrated.partitions['codex:desktop'].sessions[oldId]).toBeUndefined();
    expect(migrated.globalOrder).toEqual([nextId]);
    await runtime.stop();
  });

  it('migrates shared legacy IDs independently across Desktop and CLI', async () => {
    const dataPath = await appDataPath();
    const oldId = 'codex:rollout-id';
    const record = reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'codex',
      surface: 'desktop',
      nativeSessionId: 'rollout-id',
      title: 'Old title',
      isTopLevel: true,
      isArchived: false,
      canOpen: false,
      updatedAt: 1,
    }).sessions[oldId];
    const saved = createInitialMonitoringState();
    for (const surface of ['desktop', 'cli'] as const) {
      const partition = saved.partitions[`codex:${surface}`];
      partition.enabled = true;
      partition.baseline = { status: 'ready', cutoff: 2 };
      partition.sessions = { [oldId]: { ...record, surface } };
      partition.order = [oldId];
      partition.cursors = { [`source-${surface}`]: { identity: 'fixture', offset: 10 } };
    }
    saved.globalOrder = [oldId];
    saved.owners = { [oldId]: 'codex:cli' };
    await saveSessionState(dataPath, saved);
    const desktop = { ...source('desktop'), legacySessionId: 'rollout-id' };
    const cli = { ...source('cli'), legacySessionId: 'rollout-id' };
    const read = async (request: RuntimeReadRequest) => ({
      events: [],
      cursors: request.cursors,
      complete: true,
    });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [monitor('codex:desktop', [desktop], read), monitor('codex:cli', [cli], read)],
    });
    await runtime.start();
    await vi.waitFor(() =>
      expect(
        runtime.getMonitoringState().partitions['codex:cli'].sessions['codex:cli'],
      ).toBeDefined(),
    );
    const migrated = (await loadSessionState(dataPath)).monitoring;
    expect(migrated.partitions['codex:desktop'].sessions['codex:desktop']).toBeDefined();
    expect(migrated.partitions['codex:cli'].sessions['codex:cli']).toBeDefined();
    expect(migrated.globalOrder).toEqual(expect.arrayContaining(['codex:desktop', 'codex:cli']));
    expect(migrated.owners['codex:desktop']).toBe('codex:desktop');
    expect(migrated.owners['codex:cli']).toBe('codex:cli');
    await runtime.stop();
  });

  it('replays a first-run surface privately and suppresses historical terminal states', async () => {
    const dataPath = await appDataPath();
    const historicalSource = source('thread-1');
    const read = vi.fn(async () => ({
      events: [
        {
          type: 'turn-started' as const,
          sessionId: 'codex:thread-1',
          turnId: 'turn-1',
          timestamp: 1,
        },
        {
          type: 'turn-completed' as const,
          sessionId: 'codex:thread-1',
          turnId: 'turn-1',
          completionId: 'completion-1',
          timestamp: 2,
        },
      ],
      cursors: {
        'source-thread-1': { identity: 'fixture', offset: 10 },
      },
      complete: true,
    }));
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [monitor('codex:desktop', [historicalSource], read)],
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');

    const loaded = await loadSessionState(dataPath);
    const partition = loaded.monitoring.partitions['codex:desktop'];
    expect(partition.baseline).toEqual({ status: 'ready', cutoff: 100 });
    expect(partition.sessions['codex:thread-1']).toMatchObject({
      status: 'idle',
      completionId: 'completion-1',
      acknowledgedCompletionId: 'completion-1',
      canOpen: false,
    });
    expect(runtime.getOverlayState().sessions).toMatchObject([
      { id: 'codex:thread-1', status: 'idle' },
    ]);

    await runtime.stop();
  });

  it('shows confirmed work during partial coverage and drops observations a later catalog omits', async () => {
    const dataPath = await appDataPath();
    const item = source('confirmed');
    let clock = 100;
    const scheduled: Array<() => void> = [];
    const testMonitor = monitor('codex:desktop', [item], async (request) => ({
      events: request.baseline
        ? [
            {
              type: 'turn-started' as const,
              sessionId: 'codex:confirmed',
              turnId: 'turn-1',
              timestamp: 101,
            },
          ]
        : [],
      cursors: request.sources.length
        ? { [item.id]: { identity: 'fixture', offset: item.endOffset ?? 0 } }
        : {},
      complete: true,
    }));
    testMonitor.discover = vi
      .fn()
      .mockResolvedValueOnce({
        complete: true,
        capturedAt: 100,
        sources: [item],
        coverageIncomplete: true,
      })
      .mockResolvedValue({
        complete: true,
        capturedAt: 102,
        sources: [],
        coverageIncomplete: true,
      });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [testMonitor],
      now: () => clock,
      filePollIntervalMs: 10,
      catalogPollIntervalMs: 10,
      setTimeout: (callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');
    expect(runtime.getHealth()['codex:desktop']).toMatchObject({
      status: 'available',
      coverageIncomplete: true,
    });
    expect(runtime.getOverlayState().sessions).toMatchObject([{ status: 'working' }]);
    clock = 111;
    scheduled.at(-1)?.();
    await vi.waitFor(() => expect(runtime.getOverlayState().sessions).toEqual([]));
    expect(runtime.getMonitoringState().partitions['codex:desktop'].sessions).toEqual({});
    expect(runtime.getMonitoringState().partitions['codex:desktop'].baseline.status).toBe('ready');
    expect(runtime.getHealth()['codex:desktop']).toMatchObject({
      status: 'available',
      coverageIncomplete: true,
    });
    await runtime.stop();
  });

  it('replays a newly confirmed source to a fixed cutoff without historical unread work', async () => {
    const dataPath = await appDataPath();
    const existing = source('existing');
    const newlyConfirmed = source('newly-confirmed', 2);
    let clock = 100;
    const scheduled: Array<() => void> = [];
    const read = vi.fn(async (request: Parameters<ProviderSurfaceMonitor['read']>[0]) => ({
      events: request.baseline
        ? [
            {
              type: 'turn-started' as const,
              sessionId: 'codex:existing',
              turnId: 'first-turn',
              timestamp: 101,
            },
          ]
        : [
            {
              type: 'turn-started' as const,
              sessionId: 'codex:newly-confirmed',
              turnId: 'old-turn',
              timestamp: 102,
            },
            {
              type: 'turn-completed' as const,
              sessionId: 'codex:newly-confirmed',
              turnId: 'old-turn',
              completionId: 'old-completion',
              timestamp: 103,
            },
          ],
      cursors: Object.fromEntries(
        request.sources.map((item) => [
          item.id,
          { identity: 'fixture', offset: item.endOffset ?? 0 },
        ]),
      ),
      complete: true,
    }));
    const testMonitor = monitor('codex:desktop', [existing], read);
    testMonitor.discover = vi
      .fn()
      .mockResolvedValueOnce({
        complete: true,
        capturedAt: 100,
        sources: [existing],
        coverageIncomplete: true,
      })
      .mockResolvedValue({ complete: true, capturedAt: 102, sources: [existing, newlyConfirmed] });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [testMonitor],
      now: () => clock,
      filePollIntervalMs: 10,
      catalogPollIntervalMs: 10,
      setTimeout: (callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');
    clock = 111;
    scheduled.at(-1)?.();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls[1][0].frozenCutoffs).toMatchObject({
      [newlyConfirmed.id]: newlyConfirmed.endOffset,
    });
    expect(
      runtime.getMonitoringState().partitions['codex:desktop'].sessions['codex:newly-confirmed']
        ?.status,
    ).toBe('idle');
    expect(runtime.getOverlayState().sessions).toMatchObject([
      { id: 'codex:newly-confirmed', status: 'idle' },
      { id: 'codex:existing', status: 'working' },
    ]);
    await runtime.stop();
  });

  it('keeps concurrent surfaces isolated while deduplicating the canonical owner', async () => {
    const dataPath = await appDataPath();
    const sharedDesktop = source('shared', 1);
    const sharedCli = source('shared', 2);
    const desktopRead = vi.fn(async () => ({
      events: [],
      cursors: { 'source-shared': { identity: 'fixture', offset: 10 } },
      complete: true,
    }));
    const cliRead = vi.fn(async () => ({
      events: [
        {
          type: 'turn-started' as const,
          sessionId: 'codex:shared',
          turnId: 'turn-shared',
          timestamp: 3,
        },
      ],
      cursors: { 'source-shared': { identity: 'fixture', offset: 20 } },
      complete: true,
    }));
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [
        monitor('codex:desktop', [sharedDesktop], desktopRead),
        monitor('codex:cli', [sharedCli], cliRead),
      ],
    });

    await runtime.start();
    await Promise.all([runtime.connect('codex', 'desktop'), runtime.connect('codex', 'cli')]);

    const state = runtime.getMonitoringState();
    expect(state.partitions['codex:desktop'].sessions['codex:shared']).toBeDefined();
    expect(state.partitions['codex:cli'].sessions['codex:shared']).toBeDefined();
    expect(state.globalOrder).toEqual(['codex:shared']);
    expect(state.owners['codex:shared']).toBe('codex:cli');
    expect(runtime.getOverlayState().sessions[0]?.title).toBe('Fixture 2');

    await runtime.stop();
  });

  it('loads a saved checkpoint before a connection requested ahead of start', async () => {
    const dataPath = await appDataPath();
    const item = source('restored');
    const first = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [
        monitor('codex:desktop', [item], async () => ({
          events: [],
          cursors: { [item.id]: { identity: 'fixture', offset: 10 } },
          complete: true,
        })),
      ],
    });
    await first.start();
    await first.connect('codex', 'desktop');
    await first.stop();

    const restarted = createRuntimeCoordinator({ appDataPath: dataPath });
    await restarted.connect('codex', 'cli');
    const restored = (await loadSessionState(dataPath)).monitoring;
    expect(restored.partitions['codex:desktop'].enabled).toBe(true);
    expect(restored.partitions['codex:desktop'].sessions['codex:restored']).toBeDefined();
    expect(restored.partitions['codex:cli'].enabled).toBe(true);
    await restarted.stop();
  });

  it('keeps a saved owner when equal recency is replayed in reverse poll order', async () => {
    const dataPath = await appDataPath();
    const desktop = source('same-owner', 1);
    const cli = source('same-owner', 1);
    const read = vi.fn(async (request: RuntimeReadRequest) => ({
      events: [],
      cursors: Object.fromEntries(
        request.sources.map((item) => [
          item.id,
          { identity: 'fixture', offset: item.endOffset ?? 0 },
        ]),
      ),
      complete: true,
    }));
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [monitor('codex:desktop', [desktop], read), monitor('codex:cli', [cli], read)],
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');
    expect(runtime.getMonitoringState().owners['codex:same-owner']).toBe('codex:desktop');

    // The CLI catalog arrives after Desktop with equal catalog/lifecycle
    // timestamps. It must not flip the checkpointed owner.
    await runtime.connect('codex', 'cli');
    expect(runtime.getMonitoringState().owners['codex:same-owner']).toBe('codex:desktop');

    await runtime.stop();
  });

  it('acknowledges the published owner when both Codex surfaces retain one session', async () => {
    const dataPath = await appDataPath();
    const id = makeSessionId('codex', 'duplicate');
    const completed = [
      {
        type: 'upsert' as const,
        provider: 'codex' as const,
        surface: 'cli' as const,
        nativeSessionId: 'duplicate',
        title: 'Fixture project',
        isTopLevel: true,
        isArchived: false,
        canOpen: false,
        updatedAt: 1,
      },
      { type: 'turn-started' as const, sessionId: id, turnId: 'turn', timestamp: 2 },
      {
        type: 'turn-completed' as const,
        sessionId: id,
        turnId: 'turn',
        completionId: 'completion',
        timestamp: 3,
      },
    ].reduce(reduceSessionState, createInitialSessionState());
    const cliRecord = completed.sessions[id];
    if (cliRecord === undefined) throw new Error('Expected fixture record');
    const monitoring = createInitialMonitoringState();
    for (const surface of ['desktop', 'cli'] as const) {
      const partition = monitoring.partitions[`codex:${surface}`];
      partition.enabled = true;
      partition.baseline = { status: 'ready', cutoff: 4 };
      partition.sessions = { [id]: { ...cliRecord, surface } };
      partition.order = [id];
    }
    monitoring.globalOrder = [id];
    monitoring.owners = { [id]: 'codex:cli' };
    await saveSessionState(dataPath, monitoring);

    const runtime = createRuntimeCoordinator({ appDataPath: dataPath });
    await runtime.start();
    expect(await runtime.acknowledge(id, 'completion')).toBe(true);
    const saved = (await loadSessionState(dataPath)).monitoring;
    expect(saved.partitions['codex:cli'].sessions[id]?.acknowledgedCompletionId).toBe('completion');
    expect(
      saved.partitions['codex:desktop'].sessions[id]?.acknowledgedCompletionId,
    ).toBeUndefined();
    await runtime.stop();
  });

  it('rejects duplicate monitor ownership before any monitor starts', async () => {
    const duplicate = monitor(
      'codex:desktop',
      [],
      vi.fn(async () => ({ events: [], cursors: {}, complete: true })),
    );
    expect(() =>
      createRuntimeCoordinator({
        appDataPath: '/tmp/agent-status-tiles-runtime-duplicate',
        monitors: [duplicate, { ...duplicate }],
      }),
    ).toThrow('Duplicate monitor codex:desktop');
    expect(duplicate.start).not.toHaveBeenCalled();
  });

  it('retains more than the overlay cap and exposes only a bounded coverage warning', async () => {
    const dataPath = await appDataPath();
    const sources = Array.from({ length: 300 }, (_, index) => source(`thread-${index}`, index + 1));
    const read = vi.fn(async () => ({
      events: sources.map((item, index) => ({
        type: 'turn-started' as const,
        sessionId: `codex:${item.nativeSessionId}`,
        turnId: `turn-${index}`,
        timestamp: index + 1,
      })),
      cursors: Object.fromEntries(
        sources.map((item) => [item.id, { identity: 'fixture', offset: item.endOffset ?? 0 }]),
      ),
      complete: true,
    }));
    let omitted = 0;
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [monitor('codex:desktop', sources, read)],
      onCoverageWarning: (count) => {
        omitted = count;
      },
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');

    expect(runtime.getOverlayState().sessions).toHaveLength(5);
    expect(omitted).toBe(44);
    expect(
      Object.keys(runtime.getMonitoringState().partitions['codex:desktop'].sessions),
    ).toHaveLength(300);

    await runtime.stop();
  });

  it('keeps a surface quietly unavailable when its installation is missing', async () => {
    const dataPath = await appDataPath();
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    let nextTimer = 1;
    const healthChanges: string[] = [];
    let installed = false;
    const missing = monitor('codex:cli', [], async () => ({
      events: [],
      cursors: {},
      complete: true,
    }));
    missing.start = vi.fn(async () => {
      if (!installed) throw new MonitorPrerequisiteError('codex-cli-path-unavailable');
    });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [missing],
      setTimeout: (callback, delayMs) => {
        const id = nextTimer++;
        timers.set(id, { callback, delayMs });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer) => {
        timers.delete(timer as unknown as number);
      },
      onHealthChanged: (key, health) => healthChanges.push(`${key}:${health.status}`),
    });
    try {
      await runtime.start();
      await runtime.connect('codex', 'cli');
      const health = runtime.getHealth()['codex:cli'];
      expect(health.status).toBe('unavailable');
      // A missing installation is re-checked at the slowest cadence without
      // exponential backoff and is never reported as an error.
      expect(health.retryInMs).toBe(15_000);
      const retry = [...timers.values()].find((timer) => timer.delayMs === 15_000);
      if (retry === undefined) throw new Error('Expected a 15 s prerequisite retry');
      expect(healthChanges).not.toContain('codex:cli:error');

      // A later install is noticed by that retry alone.
      installed = true;
      retry.callback();
      await vi.waitFor(() => expect(runtime.getHealth()['codex:cli'].status).toBe('available'));
      expect(missing.start).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });

  it('cancels the prerequisite retry when the surface is disconnected', async () => {
    const dataPath = await appDataPath();
    const timers = new Map<number, number>();
    const cleared: number[] = [];
    let nextTimer = 1;
    const missing = monitor('codex:cli', [], async () => ({
      events: [],
      cursors: {},
      complete: true,
    }));
    missing.start = vi.fn(async () => {
      throw new MonitorPrerequisiteError('codex-cli-path-unavailable');
    });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [missing],
      setTimeout: (_callback, delayMs) => {
        const id = nextTimer++;
        timers.set(id, delayMs);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer) => {
        cleared.push(timer as unknown as number);
        timers.delete(timer as unknown as number);
      },
    });
    try {
      await runtime.start();
      await runtime.connect('codex', 'cli');
      const [retryId] = [...timers.entries()].find(([, delayMs]) => delayMs === 15_000) ?? [];
      if (retryId === undefined) throw new Error('Expected a 15 s prerequisite retry');
      await runtime.disconnect('codex', 'cli');
      expect(cleared).toContain(retryId);
      expect(runtime.getHealth()['codex:cli'].status).toBe('stopped');
      expect([...timers.values()]).not.toContain(15_000);
    } finally {
      await runtime.stop();
    }
  });

  it('reports an error with backoff when a monitor fails to start for another reason', async () => {
    const dataPath = await appDataPath();
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    let nextTimer = 1;
    const broken = monitor('codex:cli', [], async () => ({
      events: [],
      cursors: {},
      complete: true,
    }));
    broken.start = vi.fn(async () => {
      throw new Error('codex-cli-code-signature-invalid');
    });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [broken],
      setTimeout: (callback, delayMs) => {
        const id = nextTimer++;
        timers.set(id, { callback, delayMs });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer) => {
        timers.delete(timer as unknown as number);
      },
    });
    try {
      await runtime.start();
      await runtime.connect('codex', 'cli');
      expect(runtime.getHealth()['codex:cli']).toMatchObject({
        status: 'error',
        retryInMs: DEFAULT_FILE_POLL_INTERVAL_MS,
      });
      const retry = [...timers.values()].find(
        (timer) => timer.delayMs === DEFAULT_FILE_POLL_INTERVAL_MS,
      );
      if (retry === undefined) throw new Error('Expected an error retry');
      retry.callback();
      // A repeated real failure doubles the delay, unlike a missing installation.
      await vi.waitFor(() =>
        expect(runtime.getHealth()['codex:cli']).toMatchObject({
          status: 'error',
          retryInMs: 2 * DEFAULT_FILE_POLL_INTERVAL_MS,
        }),
      );
      expect(broken.start).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
    }
  });

  it('does not publish or mark a baseline ready when a bounded read is incomplete', async () => {
    const dataPath = await appDataPath();
    const item = source('incomplete');
    const published: string[] = [];
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [
        monitor(
          'codex:desktop',
          [item],
          vi.fn(async () => ({
            events: [],
            cursors: { [item.id]: { identity: 'fixture', offset: 0 } },
            complete: false,
          })),
        ),
      ],
      onOverlayState: (state) => published.push(JSON.stringify(state)),
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');

    expect(runtime.getMonitoringState().partitions['codex:desktop'].baseline).toEqual({
      status: 'pending',
    });
    expect(runtime.getMonitoringState().partitions['codex:desktop'].sessions).toEqual({});
    expect(runtime.getHealth()['codex:desktop'].status).toBe('error');
    expect(runtime.getOverlayState().sessions).toEqual([]);
    expect(published.every((value) => !value.includes('incomplete'))).toBe(true);
    await runtime.stop();
  });

  it('rejects capture metadata that changes a discovered source identity', async () => {
    const dataPath = await appDataPath();
    const item = source('qualified');
    const read = vi.fn(async () => ({
      events: [],
      cursors: { [item.id]: { identity: 'fixture', offset: 10 } },
      complete: true,
    }));
    const testMonitor = monitor('codex:desktop', [item], read);
    testMonitor.capture = async () => [{ ...item, nativeSessionId: 'different' }];
    const runtime = createRuntimeCoordinator({ appDataPath: dataPath, monitors: [testMonitor] });

    await runtime.start();
    await runtime.connect('codex', 'desktop');
    expect(runtime.getMonitoringState().partitions['codex:desktop'].baseline).toEqual({
      status: 'pending',
    });
    expect(runtime.getMonitoringState().partitions['codex:desktop'].sessions).toEqual({});
    expect(runtime.getHealth()['codex:desktop'].status).toBe('error');
    expect(read).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('does not commit malformed reader events as a healthy baseline', async () => {
    const dataPath = await appDataPath();
    const item = source('malformed');
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [
        monitor('codex:desktop', [item], async () => ({
          events: [{ type: 'turn-completed', sessionId: 'codex:malformed' }] as never,
          cursors: { [item.id]: { identity: 'fixture', offset: 10 } },
          complete: true,
        })),
      ],
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');
    expect(runtime.getMonitoringState().partitions['codex:desktop'].baseline).toEqual({
      status: 'pending',
    });
    expect(runtime.getHealth()['codex:desktop'].status).toBe('error');
    await runtime.stop();
  });

  it('passes fixed EOFs to the monitor so appended data stays outside the baseline replay', async () => {
    const dataPath = await appDataPath();
    const item = source('cutoff');
    const requests: RuntimeReadRequest[] = [];
    const scheduled: Array<() => void> = [];
    const read = vi.fn(async (request: RuntimeReadRequest) => {
      requests.push(request);
      if (!request.baseline) {
        return {
          events: [
            {
              type: 'turn-started' as const,
              sessionId: 'codex:cutoff',
              turnId: 'appended-turn',
              timestamp: 101,
            },
          ],
          cursors: { [item.id]: { identity: 'fixture', offset: 20 } },
          complete: true,
        };
      }
      return {
        events: [],
        cursors: { [item.id]: { identity: 'fixture', offset: 10 } },
        complete: true,
      };
    });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [monitor('codex:desktop', [item], read)],
      setTimeout: (callback) => {
        scheduled.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');

    expect(requests[0]?.baseline).toBe(true);
    expect(requests[0]?.frozenCutoffs[item.id]).toBe(10);
    expect(runtime.getMonitoringState().partitions['codex:desktop'].baseline).toEqual({
      status: 'ready',
      cutoff: 100,
    });
    scheduled.shift()?.();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(requests[1]?.baseline).toBe(false);
    expect(requests[1]?.frozenCutoffs).toEqual({});
    await vi.waitFor(() => expect(runtime.getOverlayState().sessions[0]?.status).toBe('working'));
    await runtime.stop();
  });

  it('rolls back an unread candidate when its checkpoint fails', async () => {
    const dataPath = await appDataPath();
    const item = source('save-failure');
    const monitorRead = vi.fn(async () => {
      await rm(dataPath, { recursive: true, force: true });
      await writeFile(dataPath, 'not a directory');
      return {
        events: [
          {
            type: 'turn-started' as const,
            sessionId: 'codex:save-failure',
            turnId: 'turn-1',
            timestamp: 1,
          },
        ],
        cursors: { [item.id]: { identity: 'fixture', offset: 10 } },
        complete: true,
      };
    });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [monitor('codex:desktop', [item], monitorRead)],
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');

    expect(runtime.getMonitoringState().partitions['codex:desktop'].sessions).toEqual({});
    expect(runtime.getMonitoringState().partitions['codex:desktop'].baseline).toEqual({
      status: 'pending',
    });
    expect(runtime.getOverlayState().sessions).toEqual([]);
    await runtime.stop();
  });

  it('cancels a stale read on disconnect and cleans monitor lifecycle on suspend/resume', async () => {
    const dataPath = await appDataPath();
    const item = source('stale');
    let releaseRead!: () => void;
    const readPending = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const read = vi.fn(async () => {
      await readPending;
      return {
        events: [
          {
            type: 'turn-started' as const,
            sessionId: 'codex:stale',
            turnId: 'turn-1',
            timestamp: 1,
          },
        ],
        cursors: { [item.id]: { identity: 'fixture', offset: 10 } },
        complete: true,
      };
    });
    const testMonitor = monitor('codex:desktop', [item], read);
    const runtime = createRuntimeCoordinator({ appDataPath: dataPath, monitors: [testMonitor] });

    await runtime.start();
    const connecting = runtime.connect('codex', 'desktop');
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const disconnecting = runtime.disconnect('codex', 'desktop');
    releaseRead();
    await Promise.all([connecting, disconnecting]);

    expect(runtime.getMonitoringState().partitions['codex:desktop'].enabled).toBe(false);
    expect(runtime.getMonitoringState().partitions['codex:desktop'].sessions).toEqual({});
    expect(testMonitor.stop).toHaveBeenCalled();

    await runtime.connect('codex', 'desktop');
    await runtime.suspend();
    const stopCalls = (): number =>
      (testMonitor.stop as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(stopCalls()).toBeGreaterThanOrEqual(3);
    await runtime.resume();
    expect(testMonitor.start).toHaveBeenCalledTimes(3);
    const stopsBeforeShutdown = stopCalls();
    await runtime.stop();
    expect(stopCalls()).toBe(stopsBeforeShutdown + 1);
  });

  it('does not let a late suspend stop overwrite resumed surface health', async () => {
    const dataPath = await appDataPath();
    const item = source('health-race');
    const testMonitor = monitor('codex:desktop', [item], async () => ({
      events: [],
      cursors: { [item.id]: { identity: 'fixture', offset: 10 } },
      complete: true,
    }));
    let releaseStop!: () => void;
    const pendingStop = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const runtime = createRuntimeCoordinator({ appDataPath: dataPath, monitors: [testMonitor] });
    await runtime.start();
    await runtime.connect('codex', 'desktop');
    testMonitor.stop = vi
      .fn()
      .mockImplementationOnce(() => pendingStop)
      .mockImplementation(async () => undefined);

    const suspending = runtime.suspend();
    await vi.waitFor(() => expect(testMonitor.stop).toHaveBeenCalledTimes(1));
    const resuming = runtime.resume();
    await vi.waitFor(() => expect(testMonitor.start).toHaveBeenCalledTimes(2));
    releaseStop();
    await Promise.all([suspending, resuming]);
    expect(runtime.getHealth()['codex:desktop'].status).toBe('available');
    await runtime.stop();
  });

  it('waits for a delayed monitor start before Disconnect stops that monitor', async () => {
    const dataPath = await appDataPath();
    const saved = createInitialMonitoringState();
    saved.partitions['codex:desktop'].enabled = true;
    await saveSessionState(dataPath, saved);
    let releaseStart!: () => void;
    const pendingStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const read = vi.fn(async () => ({
      events: [],
      cursors: {},
      complete: true,
    }));
    const testMonitor = monitor('codex:desktop', [], read);
    testMonitor.start = vi.fn(() => pendingStart);
    const runtime = createRuntimeCoordinator({ appDataPath: dataPath, monitors: [testMonitor] });

    const starting = runtime.start();
    await vi.waitFor(() => expect(testMonitor.start).toHaveBeenCalledTimes(1));
    const disconnecting = runtime.disconnect('codex', 'desktop');
    releaseStart();
    await Promise.all([starting, disconnecting]);
    expect(testMonitor.stop).toHaveBeenCalled();
    expect(runtime.getMonitoringState().partitions['codex:desktop'].enabled).toBe(false);
    expect(read).not.toHaveBeenCalled();
    await runtime.stop();
  });
  it('polls the catalog every two seconds by default while files poll continuously', async () => {
    expect(DEFAULT_CATALOG_POLL_INTERVAL_MS).toBe(2_000);
    expect(DEFAULT_FILE_POLL_INTERVAL_MS).toBe(250);
    const dataPath = await appDataPath();
    const item = source('steady');
    let clock = 100;
    const scheduled: Array<() => void> = [];
    const read = vi.fn(async (request: RuntimeReadRequest) => ({
      events: [],
      cursors: Object.fromEntries(
        request.sources.map((entry) => [
          entry.id,
          { identity: 'fixture', offset: entry.endOffset ?? 0 },
        ]),
      ),
      complete: true,
    }));
    const testMonitor = monitor('codex:desktop', [item], read);
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [testMonitor],
      now: () => clock,
      setTimeout: (callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');
    // Connect forces a catalog read.
    expect(testMonitor.discover).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);

    // Each completed run schedules the next file poll; fire it once it exists.
    const firePendingPoll = async (): Promise<void> => {
      const pending = scheduled.length;
      scheduled.at(-1)?.();
      await vi.waitFor(() => expect(scheduled.length).toBeGreaterThan(pending));
    };

    // File polls between listings carry live status without a catalog read.
    for (const step of [1, 2, 3]) {
      clock = 100 + step * DEFAULT_FILE_POLL_INTERVAL_MS;
      await firePendingPoll();
      expect(read).toHaveBeenCalledTimes(1 + step);
      expect(testMonitor.discover).toHaveBeenCalledTimes(1);
    }

    clock = 100 + DEFAULT_CATALOG_POLL_INTERVAL_MS;
    await firePendingPoll();
    expect(testMonitor.discover).toHaveBeenCalledTimes(2);

    // Resume also forces a catalog read regardless of elapsed time.
    await runtime.suspend();
    await runtime.resume();
    expect(testMonitor.discover).toHaveBeenCalledTimes(3);
    await runtime.stop();
  });

  it('drops a stale archived session that discovery no longer reports', async () => {
    const dataPath = await appDataPath();
    const archivedId = makeSessionId('codex', 'archived-thread');
    const live = source('live-thread');
    const liveId = makeSessionId('codex', live.nativeSessionId);
    const savedState = reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'codex',
      surface: 'desktop',
      nativeSessionId: 'archived-thread',
      title: 'Archived earlier',
      isTopLevel: true,
      isArchived: true,
      canOpen: false,
      updatedAt: 1,
    });
    const saved = createInitialMonitoringState();
    const partition = saved.partitions['codex:desktop'];
    partition.enabled = true;
    partition.baseline = { status: 'ready', cutoff: 2 };
    partition.sessions = savedState.sessions;
    partition.order = [archivedId];
    saved.globalOrder = [archivedId];
    saved.owners = { [archivedId]: 'codex:desktop' };
    await saveSessionState(dataPath, saved);
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [
        monitor('codex:desktop', [live], async (request) => ({
          events: [],
          cursors: Object.fromEntries(
            request.sources.map((entry) => [
              entry.id,
              { identity: 'fixture', offset: entry.endOffset ?? 0 },
            ]),
          ),
          complete: true,
        })),
      ],
    });

    await runtime.start();
    await vi.waitFor(() =>
      expect(
        runtime.getMonitoringState().partitions['codex:desktop'].sessions[liveId],
      ).toBeDefined(),
    );
    const partitionAfter = runtime.getMonitoringState().partitions['codex:desktop'];
    expect(partitionAfter.sessions[archivedId]).toBeUndefined();
    expect(partitionAfter.order).toEqual([liveId]);
    expect(runtime.getMonitoringState().globalOrder).toEqual([liveId]);
    expect(runtime.getMonitoringState().owners[archivedId]).toBeUndefined();
    expect(runtime.getOverlayState().sessions.map((session) => session.id)).toEqual([liveId]);
    const persisted = (await loadSessionState(dataPath)).monitoring;
    expect(persisted.partitions['codex:desktop'].sessions[archivedId]).toBeUndefined();
    expect(persisted.globalOrder).toEqual([liveId]);
    await runtime.stop();
  });

  it('removes a visible thread on the next discovery once it is archived', async () => {
    const dataPath = await appDataPath();
    const item = source('archived-later');
    const sessionId = makeSessionId('codex', item.nativeSessionId);
    let clock = 100;
    const scheduled: Array<() => void> = [];
    const testMonitor = monitor('codex:desktop', [item], async (request) => ({
      events: [],
      cursors: Object.fromEntries(
        request.sources.map((entry) => [
          entry.id,
          { identity: 'fixture', offset: entry.endOffset ?? 0 },
        ]),
      ),
      complete: true,
    }));
    // Archiving moves the thread off the live page, so the adapter simply
    // stops reporting it; no archived listing is involved.
    testMonitor.discover = vi
      .fn()
      .mockResolvedValueOnce({ complete: true, capturedAt: 100, sources: [item] })
      .mockResolvedValue({ complete: true, capturedAt: 200, sources: [] });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [testMonitor],
      now: () => clock,
      filePollIntervalMs: 10,
      catalogPollIntervalMs: 10,
      setTimeout: (callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');
    expect(runtime.getOverlayState().sessions).toMatchObject([{ id: sessionId, status: 'idle' }]);

    clock = 200;
    scheduled.at(-1)?.();
    await vi.waitFor(() => expect(runtime.getOverlayState().sessions).toEqual([]));
    expect(testMonitor.discover).toHaveBeenCalledTimes(2);
    const partition = runtime.getMonitoringState().partitions['codex:desktop'];
    expect(partition.sessions[sessionId]).toBeUndefined();
    expect(partition.order).toEqual([]);
    expect(partition.cursors[item.id]).toBeUndefined();
    expect(runtime.getMonitoringState().globalOrder).toEqual([]);
    expect(runtime.getHealth()['codex:desktop'].status).toBe('available');
    await runtime.stop();
  });
  it('drops an unread thread once a completed catalog no longer reports it', async () => {
    const dataPath = await appDataPath();
    const item = source('completed-then-gone');
    const sessionId = makeSessionId('codex', item.nativeSessionId);
    let clock = 100;
    const scheduled: Array<() => void> = [];
    let reads = 0;
    const testMonitor = monitor('codex:desktop', [item], async (request) => {
      reads += 1;
      return {
        // The second read (first live file poll) reports a completed turn.
        events:
          reads === 2
            ? [
                { type: 'turn-started' as const, sessionId, turnId: 'turn-1', timestamp: 120 },
                {
                  type: 'turn-completed' as const,
                  sessionId,
                  turnId: 'turn-1',
                  completionId: 'completion-1',
                  timestamp: 121,
                },
              ]
            : [],
        cursors: Object.fromEntries(
          request.sources.map((entry) => [
            entry.id,
            { identity: 'fixture', offset: (entry.endOffset ?? 0) + reads },
          ]),
        ),
        complete: true,
      };
    });
    testMonitor.discover = vi
      .fn()
      .mockResolvedValueOnce({ complete: true, capturedAt: 100, sources: [item] })
      .mockResolvedValue({ complete: true, capturedAt: 300, sources: [] });
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [testMonitor],
      now: () => clock,
      filePollIntervalMs: 10,
      catalogPollIntervalMs: 100,
      setTimeout: (callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    });

    await runtime.start();
    await runtime.connect('codex', 'desktop');
    expect(runtime.getOverlayState().sessions).toMatchObject([{ id: sessionId, status: 'idle' }]);

    // A file poll (no catalog) turns the thread unread.
    clock = 120;
    scheduled.at(-1)?.();
    await vi.waitFor(() =>
      expect(runtime.getOverlayState().sessions).toMatchObject([{ status: 'unread' }]),
    );
    expect(testMonitor.discover).toHaveBeenCalledTimes(1);

    // The next catalog omits the thread; unread state does not keep it visible.
    clock = 300;
    scheduled.at(-1)?.();
    await vi.waitFor(() => expect(runtime.getOverlayState().sessions).toEqual([]));
    expect(testMonitor.discover).toHaveBeenCalledTimes(2);
    expect(runtime.getMonitoringState().partitions['codex:desktop'].sessions).toEqual({});
    expect(runtime.getMonitoringState().globalOrder).toEqual([]);
    expect(
      (await loadSessionState(dataPath)).monitoring.partitions['codex:desktop'].sessions,
    ).toEqual({});
    await runtime.stop();
  });
});

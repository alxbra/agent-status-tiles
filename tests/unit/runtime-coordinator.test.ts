import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
    const published: string[] = [];
    const runtime = createRuntimeCoordinator({
      appDataPath: dataPath,
      monitors: [monitor('codex:desktop', [historicalSource], read)],
      onOverlayState: (state) =>
        published.push(state.sessions.map((session) => session.id).join(',')),
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
    expect(runtime.getOverlayState().sessions).toEqual([]);
    expect(published.at(-1)).toBe('');

    await runtime.stop();
  });

  it('shows confirmed work during partial coverage and marks lost observations unavailable', async () => {
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
    await vi.waitFor(() =>
      expect(runtime.getOverlayState().sessions).toMatchObject([{ status: 'unavailable' }]),
    );
    expect(runtime.getMonitoringState().partitions['codex:desktop'].baseline.status).toBe('ready');
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

    expect(runtime.getOverlayState().sessions).toHaveLength(256);
    expect(omitted).toBe(44);
    expect(
      Object.keys(runtime.getMonitoringState().partitions['codex:desktop'].sessions),
    ).toHaveLength(300);

    await runtime.stop();
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
});

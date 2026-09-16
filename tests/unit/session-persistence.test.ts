import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  connectSessionSurface,
  connectMonitoringSurface,
  createInitialMonitoringState,
  disconnectSessionSurface,
  disconnectMonitoringSurface,
  loadSessionState,
  saveSessionState,
} from '../../src/main/sessions/persistence';
import { makeCursorKey, type FileCursorMap } from '../../src/shared/cursor';
import type { SurfaceKey } from '../../src/shared/monitoring';
import {
  createInitialSessionState,
  makeSessionId,
  type SessionEvent,
  type SessionState,
} from '../../src/shared/session';
import {
  reduceSessionState,
  selectSession,
  selectSessionSnapshots,
} from '../../src/main/sessions/reducer';

const readProbe = vi.hoisted(() => ({ capped: false, calls: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) =>
      actual.open(...args).then((handle) => {
        if (!readProbe.capped) return handle;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property !== 'read') return Reflect.get(target, property, receiver);
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              readProbe.calls += 1;
              return target.read(buffer, offset, Math.min(length, 7), position);
            };
          },
        });
      }),
  };
});

const sessionId = makeSessionId('codex', 'thread-1');
const cursorMap: FileCursorMap = {
  [makeCursorKey('codex', 'events/thread-1.jsonl')]: {
    identity: 'file-1',
    offset: 42,
    baselineUntilOffset: 64,
    isDiscardingOversizedLine: true,
  },
};
const temporaryDirectories: string[] = [];

function upsert(nativeSessionId = 'thread-1'): SessionEvent {
  return {
    type: 'upsert',
    provider: 'codex',
    nativeSessionId,
    surface: 'cli',
    title: 'Session title',
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
    updatedAt: 10,
  };
}

function reduceAll(state: SessionState, events: SessionEvent[]): SessionState {
  return events.reduce(reduceSessionState, state);
}

function stateWithSession(): SessionState {
  return reduceSessionState(createInitialSessionState(), upsert());
}

function stateWithUnread(): SessionState {
  return reduceAll(stateWithSession(), [
    { type: 'turn-started', sessionId, turnId: 'turn-1', timestamp: 100 },
    {
      type: 'turn-completed',
      sessionId,
      turnId: 'turn-1',
      completionId: 'completion-1',
      timestamp: 110,
    },
  ]);
}

function stateWithError(): SessionState {
  return reduceAll(stateWithSession(), [
    { type: 'turn-started', sessionId, turnId: 'turn-1', timestamp: 100 },
    { type: 'turn-failed', sessionId, turnId: 'turn-1', timestamp: 110 },
  ]);
}

async function isolatedDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-status-tiles-persistence-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('session persistence', () => {
  it('signals a first-install baseline when no trusted state exists', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');

    const result = await loadSessionState(appDataPath);

    expect(result).toMatchObject({
      baselineRequired: true,
      source: 'first-install',
      cursors: {},
    });
    expect(result.state.sessions).toEqual({});
    expect(result.state.providerHealth).toEqual({
      codex: { status: 'unavailable', updatedAt: 0 },
      claude: { status: 'unavailable', updatedAt: 0 },
    });
  });

  it('round-trips metadata, active input correlation, cursors, and derived status', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const state = reduceAll(stateWithSession(), [
      { type: 'turn-started', sessionId, turnId: 'turn-1', timestamp: 100 },
      {
        type: 'input-requested',
        sessionId,
        turnId: 'turn-1',
        callId: 'call-1',
        timestamp: 110,
      },
    ]);
    const record = state.sessions[sessionId];
    if (record === undefined) throw new Error('expected test session');
    const stateWithSensitiveFields = {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...record,
          prompt: 'do not persist this prompt',
          transcript: 'do not persist this transcript',
          tool_input: 'do not persist this tool input',
          inputRequests: {
            ...record.inputRequests,
            'call-1': {
              ...record.inputRequests['call-1'],
              prompt: 'do not persist this input prompt',
              transcript: 'do not persist this input transcript',
              tool_input: 'do not persist this input tool input',
            },
          },
        },
      },
    } as unknown as SessionState;

    await saveSessionState(appDataPath, stateWithSensitiveFields, cursorMap);
    const result = await loadSessionState(appDataPath);
    const payload = await readFile(join(appDataPath, 'session-state.json'), 'utf8');

    expect(result.baselineRequired).toBe(false);
    expect(result.source).toBe('restored');
    expect(result.cursors).toEqual(cursorMap);
    expect(selectSession(result.state, sessionId)).toMatchObject({
      provider: 'codex',
      surface: 'cli',
      title: 'Session title',
      status: 'needs-input',
    });
    expect(result.state.sessions[sessionId].inputRequests).toEqual({
      'call-1': { turnId: 'turn-1', requestedAt: 110 },
    });
    expect(result.state.providerHealth.codex.status).toBe('unavailable');
    expect(payload).not.toMatch(/do not persist|prompt|transcript|tool_input/);
  });

  it('serializes concurrent saves so a later acknowledgement and cursor win together', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const unread = stateWithUnread();
    const acknowledged = reduceSessionState(unread, {
      type: 'acknowledged',
      sessionId,
      expectedCompletionId: 'completion-1',
      timestamp: 120,
    });
    const newerCursors: FileCursorMap = {
      [makeCursorKey('codex', 'events/thread-1.jsonl')]: { identity: 'file-2', offset: 88 },
    };

    await Promise.all([
      saveSessionState(appDataPath, unread, cursorMap),
      saveSessionState(appDataPath, acknowledged, newerCursors),
    ]);
    const result = await loadSessionState(appDataPath);

    expect(selectSession(result.state, sessionId)?.status).toBe('idle');
    expect(result.cursors).toEqual(newerCursors);
  });

  it('continues a queued save after an earlier queued save is rejected', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const state = stateWithSession();
    const record = state.sessions[sessionId];
    if (record === undefined) throw new Error('expected test session');
    const invalid = {
      ...state,
      sessions: { ...state.sessions, [sessionId]: { ...record, activeTurnId: 'turn-1' } },
    };
    const expected = stateWithUnread();
    const expectedCursors: FileCursorMap = {
      [makeCursorKey('codex', 'events/thread-1.jsonl')]: {
        identity: 'latest-file',
        offset: 99,
        baselineUntilOffset: 101,
        isDiscardingOversizedLine: false,
      },
    };

    const rejected = saveSessionState(appDataPath, invalid, cursorMap);
    const succeeded = saveSessionState(appDataPath, expected, expectedCursors);
    await expect(rejected).rejects.toMatchObject({ code: 'corrupt' });
    await expect(succeeded).resolves.toBeUndefined();

    const result = await loadSessionState(appDataPath);
    expect(selectSession(result.state, sessionId)?.status).toBe('unread');
    expect(result.cursors).toEqual(expectedCursors);
  });

  it('preserves order and cursors as one atomic snapshot', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const secondId = makeSessionId('claude', 'session-2');
    const state = reduceAll(stateWithSession(), [
      upsert('session-2'),
      {
        type: 'upsert',
        provider: 'claude',
        nativeSessionId: 'session-2',
        surface: 'desktop',
        title: 'Second session',
        isTopLevel: true,
        isArchived: false,
        canOpen: true,
        updatedAt: 20,
      },
      { type: 'turn-started', sessionId, turnId: 'turn-1', timestamp: 100 },
      { type: 'turn-started', sessionId: secondId, turnId: 'turn-2', timestamp: 101 },
    ]);
    const cursors: FileCursorMap = {
      [makeCursorKey('codex', 'events/thread-1.jsonl')]: {
        identity: 'codex-file',
        offset: 1,
      },
      [makeCursorKey('claude', 'events/session-2.jsonl')]: {
        identity: 'claude-file',
        offset: 2,
      },
    };

    await saveSessionState(appDataPath, state, cursors);
    const result = await loadSessionState(appDataPath);

    expect(selectSessionSnapshots(result.state).map(({ id }) => id)).toEqual(
      selectSessionSnapshots(state).map(({ id }) => id),
    );
    expect(result.cursors).toEqual(cursors);
  });

  it('reconstructs a valid state when reads return short chunks', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    await saveSessionState(appDataPath, stateWithUnread(), cursorMap);

    readProbe.capped = true;
    readProbe.calls = 0;
    try {
      const result = await loadSessionState(appDataPath);
      expect(result.source).toBe('restored');
      expect(selectSession(result.state, sessionId)?.status).toBe('unread');
      expect(result.cursors).toEqual(cursorMap);
    } finally {
      readProbe.capped = false;
    }
    expect(readProbe.calls).toBeGreaterThan(1);
  });

  it('restores unread, acknowledged, error, and dismissed states across saves', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const unread = stateWithUnread();
    await saveSessionState(appDataPath, unread, {});
    expect(selectSession((await loadSessionState(appDataPath)).state, sessionId)?.status).toBe(
      'unread',
    );

    const acknowledged = reduceSessionState(unread, {
      type: 'acknowledged',
      sessionId,
      expectedCompletionId: 'completion-1',
      timestamp: 120,
    });
    await saveSessionState(appDataPath, acknowledged, {});
    expect(selectSession((await loadSessionState(appDataPath)).state, sessionId)?.status).toBe(
      'idle',
    );

    const error = stateWithError();
    await saveSessionState(appDataPath, error, {});
    expect(selectSession((await loadSessionState(appDataPath)).state, sessionId)?.status).toBe(
      'error',
    );

    const dismissed = reduceSessionState(error, {
      type: 'dismissed-error',
      sessionId,
      timestamp: 120,
    });
    await saveSessionState(appDataPath, dismissed, {});
    expect(selectSession((await loadSessionState(appDataPath)).state, sessionId)?.status).toBe(
      'idle',
    );
  });

  it('reports malformed, unsupported, and oversized state instead of resetting it', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const statePath = join(appDataPath, 'session-state.json');
    await mkdir(appDataPath, { recursive: true });

    await writeFile(statePath, '{not-json');
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'corrupt' });

    const malformed = JSON.stringify({
      schemaVersion: 1,
      sessions: {},
      order: [],
      cursors: {},
      transcript: 'must not be accepted',
    });
    await writeFile(statePath, malformed);
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'corrupt' });
    expect(await readFile(statePath, 'utf8')).toBe(malformed);

    await writeFile(
      statePath,
      JSON.stringify({ schemaVersion: 2, sessions: {}, order: [], cursors: {} }),
    );
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({
      code: 'unsupported-version',
    });

    await writeFile(statePath, 'x'.repeat(1024 * 1024 + 1));
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'oversized' });

    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        order: [],
        cursors: { 'codex:/absolute/path': { identity: 'file', offset: 0 } },
      }),
    );
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'unsafe' });

    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        order: [],
        cursors: {
          [makeCursorKey('codex', 'events')]: {
            identity: 'file',
            offset: 0,
            baselineUntilOffset: -1,
          },
        },
      }),
    );
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'corrupt' });

    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        order: [],
        cursors: {
          [makeCursorKey('codex', 'events')]: {
            identity: 'file',
            offset: 0,
            isDiscardingOversizedLine: 'true',
          },
        },
      }),
    );
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'corrupt' });

    const tooManyCursors = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [
        makeCursorKey('codex', `events/${index}`),
        { identity: 'file', offset: 0 },
      ]),
    );
    await writeFile(
      statePath,
      JSON.stringify({ schemaVersion: 1, sessions: {}, order: [], cursors: tooManyCursors }),
    );
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'oversized' });

    const tooManySessions = Object.fromEntries(
      Array.from({ length: 1025 }, (_, index) => [`codex:session-${index}`, {}]),
    );
    await writeFile(
      statePath,
      JSON.stringify({ schemaVersion: 1, sessions: tooManySessions, order: [], cursors: {} }),
    );
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'oversized' });
  });

  it('rejects mismatched records and impossible active/completed turn states', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const base = stateWithSession();
    const record = base.sessions[sessionId];
    if (record === undefined) throw new Error('expected test session');
    await saveSessionState(appDataPath, base, {});
    const previousPayload = await readFile(join(appDataPath, 'session-state.json'), 'utf8');

    const mismatched = {
      ...base,
      sessions: { ...base.sessions, [sessionId]: { ...record, id: 'codex:other' } },
    };
    await expect(saveSessionState(appDataPath, mismatched, {})).rejects.toMatchObject({
      code: 'unsafe',
    });
    expect(await readFile(join(appDataPath, 'session-state.json'), 'utf8')).toBe(previousPayload);

    const malformed = {
      ...base,
      sessions: { ...base.sessions, [sessionId]: null },
    } as unknown as SessionState;
    await expect(saveSessionState(appDataPath, malformed, {})).rejects.toMatchObject({
      code: 'corrupt',
    });
    expect(await readFile(join(appDataPath, 'session-state.json'), 'utf8')).toBe(previousPayload);

    const activeWithoutTurnKey = {
      ...base,
      sessions: { ...base.sessions, [sessionId]: { ...record, activeTurnId: 'turn-1' } },
    };
    await expect(saveSessionState(appDataPath, activeWithoutTurnKey, {})).rejects.toMatchObject({
      code: 'corrupt',
    });

    const completed = stateWithUnread();
    const completedRecord = completed.sessions[sessionId];
    if (completedRecord === undefined) throw new Error('expected completed test session');
    const activeAndCompleted = {
      ...completed,
      sessions: {
        ...completed.sessions,
        [sessionId]: { ...completedRecord, activeTurnId: 'turn-1' },
      },
    };
    await expect(saveSessionState(appDataPath, activeAndCompleted, {})).rejects.toMatchObject({
      code: 'corrupt',
    });

    const statePath = join(appDataPath, 'session-state.json');
    const encoded = JSON.parse(previousPayload) as {
      partitions: Record<SurfaceKey, { sessions: Record<string, Record<string, unknown>> }>;
    };
    encoded.partitions['codex:cli'].sessions[sessionId].activeTurnId = 'turn-1';
    await writeFile(statePath, JSON.stringify(encoded));
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'corrupt' });

    const completedPayload = JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            ...completedRecord,
            status: undefined,
          },
        },
        order: [sessionId],
        cursors: {},
      }),
    ) as { sessions: Record<string, Record<string, unknown>> };
    completedPayload.sessions[sessionId].activeTurnId = 'turn-1';
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        sessions: completedPayload.sessions,
        order: [sessionId],
        cursors: {},
      }),
    );
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('rejects unsafe records and keeps a previous file on write failure', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    await saveSessionState(appDataPath, stateWithUnread(), cursorMap);
    const statePath = join(appDataPath, 'session-state.json');
    const previousPayload = await readFile(statePath, 'utf8');
    expect(previousPayload).not.toMatch(/prompt|transcript|tool_input/);
    expect((await lstat(appDataPath)).mode & 0o077).toBe(0);
    expect((await lstat(statePath)).mode & 0o0777).toBe(0o600);

    await chmod(appDataPath, 0o500);
    await expect(saveSessionState(appDataPath, stateWithError(), {})).rejects.toMatchObject({
      code: 'io',
    });
    await chmod(appDataPath, 0o700);
    expect(await readFile(statePath, 'utf8')).toBe(previousPayload);
    expect((await readdir(appDataPath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const unsafePath = join(await isolatedDirectory(), 'unsafe-app-data');
    await mkdir(unsafePath, { recursive: true });
    const outsidePath = join(await isolatedDirectory(), 'outside.json');
    await writeFile(outsidePath, 'keep');
    await symlink(outsidePath, join(unsafePath, 'session-state.json'));
    await expect(saveSessionState(unsafePath, stateWithUnread(), {})).rejects.toMatchObject({
      code: 'unsafe',
    });
    expect(await readFile(outsidePath, 'utf8')).toBe('keep');
    await expect(loadSessionState(unsafePath)).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('creates four default off, empty, pending partitions on first install', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const result = await loadSessionState(appDataPath);

    expect(Object.keys(result.monitoring.partitions)).toEqual([
      'codex:desktop',
      'codex:cli',
      'claude:desktop',
      'claude:cli',
    ]);
    for (const partition of Object.values(result.monitoring.partitions)) {
      expect(partition).toMatchObject({
        enabled: false,
        baseline: { status: 'pending' },
        sessions: {},
        order: [],
        cursors: {},
        legacyRetained: false,
      });
    }
    expect(result.monitoring.globalOrder).toEqual([]);
    expect(result.monitoring.owners).toEqual({});
  });

  it('migrates an empty v1 checkpoint to default v2 without rewriting the legacy file', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const statePath = join(appDataPath, 'session-state.json');
    const legacy = JSON.stringify({
      schemaVersion: 1,
      sessions: {},
      order: [],
      cursors: { [makeCursorKey('codex', 'events.jsonl')]: { identity: 'legacy', offset: 4 } },
    });
    await mkdir(appDataPath, { recursive: true });
    await writeFile(statePath, legacy);

    const result = await loadSessionState(appDataPath);
    expect(result.source).toBe('migrated');
    expect(result.monitoring).toEqual(createInitialMonitoringState());
    expect(result.baselineRequired).toBe(true);
    expect(await readFile(statePath, 'utf8')).toBe(legacy);
  });

  it('migrates non-empty v1 records into isolated legacy-retained surfaces and rebaselines cursors', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const statePath = join(appDataPath, 'session-state.json');
    const unread = stateWithUnread();
    const legacySessions = Object.fromEntries(
      Object.entries(unread.sessions).map(([id, record]) => {
        const storedRecord = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
        delete storedRecord.status;
        return [id, storedRecord];
      }),
    );
    const legacy = JSON.stringify({
      schemaVersion: 1,
      sessions: legacySessions,
      order: unread.order,
      cursors: cursorMap,
    });
    await mkdir(appDataPath, { recursive: true });
    await writeFile(statePath, legacy);

    const result = await loadSessionState(appDataPath);
    const partition = result.monitoring.partitions['codex:cli'];
    expect(partition).toMatchObject({
      enabled: false,
      baseline: { status: 'pending' },
      order: [sessionId],
      cursors: {},
      legacyRetained: true,
    });
    expect(partition.sessions[sessionId]).toMatchObject({
      completionId: 'completion-1',
      turnKey: { turnId: 'turn-1', timestamp: 100 },
    });
    expect(result.monitoring.globalOrder).toEqual([sessionId]);
    expect(result.state.sessions).toEqual({});
    expect(result.baselineRequired).toBe(true);
    expect(await readFile(statePath, 'utf8')).toBe(legacy);
  });

  it('keeps surface cursors independent and connect changes only the chosen partition', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const initial = createInitialMonitoringState();
    const mutable = initial.partitions as Record<
      SurfaceKey,
      (typeof initial.partitions)[SurfaceKey]
    >;
    mutable['codex:cli'] = {
      ...mutable['codex:cli'],
      enabled: true,
      baseline: { status: 'ready', cutoff: 10 },
      cursors: { 'codex-cli.jsonl': { identity: 'cli-file', offset: 3 } },
    };
    mutable['claude:desktop'] = {
      ...mutable['claude:desktop'],
      enabled: true,
      baseline: { status: 'ready', cutoff: 11 },
      cursors: { 'claude-desktop.jsonl': { identity: 'desktop-file', offset: 4 } },
    };
    await saveSessionState(appDataPath, initial);
    const result = await loadSessionState(appDataPath);
    expect(result.monitoring.partitions['codex:cli'].cursors).toEqual({
      'codex-cli.jsonl': { identity: 'cli-file', offset: 3 },
    });
    expect(result.monitoring.partitions['claude:desktop'].cursors).toEqual({
      'claude-desktop.jsonl': { identity: 'desktop-file', offset: 4 },
    });
    const connected = connectMonitoringSurface(result.monitoring, 'codex', 'desktop');
    expect(connected.partitions['codex:desktop']).toMatchObject({
      enabled: true,
      baseline: { status: 'pending' },
    });
    expect(connected.partitions['codex:cli']).toEqual(result.monitoring.partitions['codex:cli']);
    expect(connected.partitions['claude:desktop']).toEqual(
      result.monitoring.partitions['claude:desktop'],
    );
  });

  it('serializes explicit connect/disconnect as atomic v2 updates', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const connected = await connectSessionSurface(appDataPath, 'claude', 'desktop');
    expect(connected.monitoring.partitions['claude:desktop']).toMatchObject({
      enabled: true,
      baseline: { status: 'pending' },
    });
    for (const key of ['codex:desktop', 'codex:cli', 'claude:cli'] as const) {
      expect(connected.monitoring.partitions[key].enabled).toBe(false);
    }

    const disconnected = await disconnectSessionSurface(appDataPath, 'claude', 'desktop');
    expect(disconnected.monitoring).toEqual(createInitialMonitoringState());
    expect(
      JSON.parse(await readFile(join(appDataPath, 'session-state.json'), 'utf8')).schemaVersion,
    ).toBe(2);
  });

  it('retains duplicate ownership until disconnect removes the last surface holder', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const record = stateWithSession().sessions[sessionId];
    if (record === undefined) throw new Error('expected test session');
    const monitoring = createInitialMonitoringState();
    const mutable = monitoring.partitions as Record<
      SurfaceKey,
      (typeof monitoring.partitions)[SurfaceKey]
    >;
    const desktopRecord = { ...record, surface: 'desktop' as const };
    for (const [key, duplicate] of [
      ['codex:cli', record],
      ['codex:desktop', desktopRecord],
    ] as const) {
      mutable[key] = {
        ...mutable[key],
        enabled: true,
        baseline: { status: 'ready', cutoff: 1 },
        sessions: { [sessionId]: duplicate },
        order: [sessionId],
      };
    }
    monitoring.globalOrder = [sessionId];
    monitoring.owners = { [sessionId]: 'codex:desktop' };
    expect(Object.keys(monitoring.partitions['codex:cli'].sessions)).toEqual([sessionId]);
    expect(Object.keys(monitoring.partitions['codex:desktop'].sessions)).toEqual([sessionId]);
    await saveSessionState(appDataPath, monitoring);
    expect((await loadSessionState(appDataPath)).state.sessions[sessionId]?.surface).toBe(
      'desktop',
    );

    const disconnected = disconnectMonitoringSurface(monitoring, 'codex', 'desktop');
    expect(disconnected.globalOrder).toEqual([sessionId]);
    expect(disconnected.owners[sessionId]).toBe('codex:cli');
    expect(disconnected.partitions['codex:desktop']).toMatchObject({
      enabled: false,
      sessions: {},
      order: [],
      cursors: {},
      legacyRetained: false,
    });
    await saveSessionState(appDataPath, disconnected);
    expect((await loadSessionState(appDataPath)).state.sessions[sessionId]?.surface).toBe('cli');
  });

  it('rejects malformed v2 roots and provider-prefixed per-surface cursors', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    await saveSessionState(appDataPath, createInitialMonitoringState());
    const statePath = join(appDataPath, 'session-state.json');
    const payload = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    payload.schemaVersion = 99;
    await writeFile(statePath, JSON.stringify(payload));
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({
      code: 'unsupported-version',
    });

    payload.schemaVersion = 2;
    const partitions = payload.partitions as Record<string, Record<string, unknown>>;
    partitions['codex:cli'].cursors = {
      'codex:events.jsonl': { identity: 'file', offset: 0 },
    };
    await writeFile(statePath, JSON.stringify(payload));
    await expect(loadSessionState(appDataPath)).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('bounds canonical IDs globally across partitions', async () => {
    const appDataPath = join(await isolatedDirectory(), 'app-data');
    const record = stateWithSession().sessions[sessionId];
    if (record === undefined) throw new Error('expected test session');
    const monitoring = createInitialMonitoringState();
    const mutable = monitoring.partitions as Record<
      SurfaceKey,
      (typeof monitoring.partitions)[SurfaceKey]
    >;
    const makeRecords = (provider: 'codex' | 'claude', surface: 'cli' | 'desktop', count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => {
          const nativeSessionId = `bounded-${provider}-${surface}-${index}`;
          const id = `${provider}:${nativeSessionId}`;
          return [
            id,
            {
              ...record,
              id,
              provider,
              surface,
              nativeSessionId,
            },
          ];
        }),
      );
    const cliSessions = makeRecords('codex', 'cli', 513);
    const desktopSessions = makeRecords('claude', 'desktop', 512);
    mutable['codex:cli'] = {
      ...mutable['codex:cli'],
      enabled: true,
      baseline: { status: 'ready', cutoff: 1 },
      sessions: cliSessions,
      order: Object.keys(cliSessions),
    };
    mutable['claude:desktop'] = {
      ...mutable['claude:desktop'],
      enabled: true,
      baseline: { status: 'ready', cutoff: 1 },
      sessions: desktopSessions,
      order: Object.keys(desktopSessions),
    };
    monitoring.globalOrder = [...Object.keys(cliSessions), ...Object.keys(desktopSessions)];
    await expect(saveSessionState(appDataPath, monitoring)).rejects.toMatchObject({
      code: 'oversized',
    });
  });
});

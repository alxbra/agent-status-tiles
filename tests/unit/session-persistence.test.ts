import { afterEach, describe, expect, it } from 'vitest';
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

import { loadSessionState, saveSessionState } from '../../src/main/sessions/persistence';
import { makeCursorKey, type FileCursorMap } from '../../src/shared/cursor';
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
      sessions: Record<string, Record<string, unknown>>;
    };
    encoded.sessions[sessionId].activeTurnId = 'turn-1';
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
});

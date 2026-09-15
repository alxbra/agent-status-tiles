import { describe, expect, it } from 'vitest';

import {
  createInitialSessionState,
  isSessionEvent,
  makeSessionId,
  type SessionEvent,
} from '../../src/shared/session';
import {
  reduceSessionState,
  selectProviderHealth,
  selectSession,
  selectSessionSnapshots,
  selectVisibleSessionSnapshots,
} from '../../src/main/sessions/reducer';

const codexId = makeSessionId('codex', 'thread-1');
const claudeId = makeSessionId('claude', 'session-1');

function upsert(
  nativeSessionId: string,
  overrides: Partial<Extract<SessionEvent, { type: 'upsert' }>> = {},
): Extract<SessionEvent, { type: 'upsert' }> {
  return {
    type: 'upsert',
    provider: 'codex',
    nativeSessionId,
    surface: 'desktop',
    title: 'A session',
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
    updatedAt: 10,
    ...overrides,
  };
}

function stateWithSession(
  nativeSessionId = 'thread-1',
  overrides: Partial<Extract<SessionEvent, { type: 'upsert' }>> = {},
) {
  return reduceSessionState(createInitialSessionState(), upsert(nativeSessionId, overrides));
}

function reduceAll(state: ReturnType<typeof createInitialSessionState>, events: SessionEvent[]) {
  return events.reduce(reduceSessionState, state);
}

describe('session identity and metadata', () => {
  it('namespaces native IDs and deduplicates the same provider session across surfaces', () => {
    const state = reduceAll(createInitialSessionState(), [
      upsert('thread-1', { surface: 'desktop', updatedAt: 10 }),
      upsert('thread-1', {
        surface: 'cli',
        title: 'CLI session',
        updatedAt: 20,
      }),
      upsert('thread-1', { surface: 'desktop', title: 'stale', updatedAt: 15 }),
    ]);

    expect(Object.keys(state.sessions)).toEqual([codexId]);
    expect(selectSession(state, codexId)).toMatchObject({
      id: codexId,
      provider: 'codex',
      surface: 'cli',
      title: 'CLI session',
    });
  });

  it('keeps ordering stable when metadata is refreshed', () => {
    const state = reduceAll(createInitialSessionState(), [
      upsert('thread-1'),
      upsert('thread-2', { title: 'Second' }),
      upsert('thread-1', { title: 'Updated', updatedAt: 30 }),
    ]);

    expect(selectSessionSnapshots(state).map(({ id }) => id)).toEqual([
      codexId,
      makeSessionId('codex', 'thread-2'),
    ]);
  });
});

describe('session lifecycle', () => {
  it('promotes only new turns and keeps overlapping input requests independent', () => {
    let state = reduceAll(stateWithSession(), [
      upsert('thread-2', { updatedAt: 11, title: 'Second' }),
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 100,
      },
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 101,
      },
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'old',
        timestamp: 99,
      },
    ]);

    expect(state.order).toEqual([codexId, makeSessionId('codex', 'thread-2')]);
    expect(selectSession(state, codexId)?.status).toBe('working');

    state = reduceAll(state, [
      {
        type: 'input-requested',
        sessionId: codexId,
        turnId: 'turn-a',
        callId: 'call-1',
        timestamp: 110,
      },
      {
        type: 'input-requested',
        sessionId: codexId,
        turnId: 'turn-a',
        callId: 'call-2',
        timestamp: 111,
      },
      {
        type: 'input-resolved',
        sessionId: codexId,
        turnId: 'turn-a',
        callId: 'call-1',
        timestamp: 120,
      },
    ]);
    expect(selectSession(state, codexId)?.status).toBe('needs-input');

    state = reduceSessionState(state, {
      type: 'input-resolved',
      sessionId: codexId,
      turnId: 'turn-a',
      callId: 'call-2',
      timestamp: 121,
    });
    expect(selectSession(state, codexId)?.status).toBe('working');
    expect(state.order).toEqual([codexId, makeSessionId('codex', 'thread-2')]);
  });

  it('orders input resolutions per call and keeps resolved-call tombstones', () => {
    let state = reduceAll(stateWithSession(), [
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 100,
      },
      {
        type: 'input-requested',
        sessionId: codexId,
        turnId: 'turn-a',
        callId: 'call-a',
        timestamp: 110,
      },
      {
        type: 'input-requested',
        sessionId: codexId,
        turnId: 'turn-a',
        callId: 'call-b',
        timestamp: 120,
      },
      {
        type: 'input-resolved',
        sessionId: codexId,
        turnId: 'turn-a',
        callId: 'call-a',
        timestamp: 115,
      },
    ]);

    expect(selectSession(state, codexId)?.status).toBe('needs-input');
    expect(state.sessions[codexId].inputRequests).toEqual({
      'call-a': { turnId: 'turn-a', requestedAt: 110, resolvedAt: 115 },
      'call-b': { turnId: 'turn-a', requestedAt: 120 },
    });

    state = reduceAll(state, [
      {
        type: 'input-requested',
        sessionId: codexId,
        turnId: 'turn-a',
        callId: 'call-a',
        timestamp: 130,
      },
      {
        type: 'input-resolved',
        sessionId: codexId,
        turnId: 'turn-a',
        callId: 'call-before-request',
        timestamp: 131,
      },
      {
        type: 'input-requested',
        sessionId: codexId,
        turnId: 'turn-a',
        callId: 'call-before-request',
        timestamp: 132,
      },
    ]);
    expect(selectSession(state, codexId)?.status).toBe('needs-input');
    expect(state.sessions[codexId].inputRequests['call-before-request']).toEqual({
      turnId: 'turn-a',
      requestedAt: 131,
      resolvedAt: 131,
    });

    state = reduceSessionState(state, {
      type: 'input-resolved',
      sessionId: codexId,
      turnId: 'turn-a',
      callId: 'call-b',
      timestamp: 121,
    });
    expect(selectSession(state, codexId)?.status).toBe('working');

    state = reduceSessionState(state, {
      type: 'input-requested',
      sessionId: codexId,
      turnId: 'turn-a',
      callId: 'call-b',
      timestamp: 140,
    });
    expect(selectSession(state, codexId)?.status).toBe('working');
  });

  it('ignores old turn activity and completion after a newer turn starts', () => {
    let state = stateWithSession();
    state = reduceAll(state, [
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 100,
      },
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-b',
        timestamp: 200,
      },
      {
        type: 'activity',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 210,
      },
      {
        type: 'turn-completed',
        sessionId: codexId,
        turnId: 'turn-a',
        completionId: 'completion-a',
        timestamp: 220,
      },
    ]);
    expect(selectSession(state, codexId)).toMatchObject({
      status: 'working',
      lastTurnStartedAt: 200,
    });

    state = reduceSessionState(state, {
      type: 'turn-completed',
      sessionId: codexId,
      turnId: 'turn-b',
      completionId: 'completion-b',
      timestamp: 230,
    });
    expect(selectSession(state, codexId)).toMatchObject({
      status: 'unread',
      completionId: 'completion-b',
    });
  });

  it('requires explicit confirmed completion and supports race-safe acknowledgement', () => {
    let state = reduceAll(stateWithSession(), [
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 100,
      },
      { type: 'activity', sessionId: codexId, timestamp: 130 },
    ]);
    expect(selectSession(state, codexId)?.status).toBe('working');

    state = reduceSessionState(state, {
      type: 'turn-completed',
      sessionId: codexId,
      turnId: 'turn-a',
      completionId: 'completion-a',
      timestamp: 120,
    });
    expect(selectSession(state, codexId)).toMatchObject({
      status: 'unread',
      completionId: 'completion-a',
    });

    state = reduceSessionState(state, {
      type: 'acknowledged',
      sessionId: codexId,
      expectedCompletionId: 'wrong',
      timestamp: 121,
    });
    expect(selectSession(state, codexId)?.status).toBe('unread');

    state = reduceAll(state, [
      {
        type: 'acknowledged',
        sessionId: codexId,
        expectedCompletionId: 'completion-a',
        timestamp: 122,
      },
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-b',
        timestamp: 130,
      },
      {
        type: 'turn-completed',
        sessionId: codexId,
        turnId: 'turn-b',
        completionId: 'completion-b',
        timestamp: 140,
      },
      {
        type: 'acknowledged',
        sessionId: codexId,
        expectedCompletionId: 'completion-a',
        timestamp: 141,
      },
    ]);
    expect(selectSession(state, codexId)).toMatchObject({
      status: 'unread',
      completionId: 'completion-b',
    });

    state = reduceSessionState(state, {
      type: 'acknowledged',
      sessionId: codexId,
      expectedCompletionId: 'completion-b',
      timestamp: 142,
    });
    expect(selectSession(state, codexId)?.status).toBe('idle');
  });

  it('keeps errors until dismissed and clears them on a new turn', () => {
    let state = reduceAll(stateWithSession(), [
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 100,
      },
      {
        type: 'turn-failed',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 110,
      },
    ]);
    expect(selectSession(state, codexId)?.status).toBe('error');

    state = reduceSessionState(state, {
      type: 'dismissed-error',
      sessionId: codexId,
      timestamp: 111,
    });
    expect(selectSession(state, codexId)?.status).toBe('idle');

    state = reduceSessionState(state, {
      type: 'turn-started',
      sessionId: codexId,
      turnId: 'turn-b',
      timestamp: 120,
    });
    expect(selectSession(state, codexId)?.status).toBe('working');
  });
});

describe('selectors and provider health', () => {
  it('hides idle, archived, and child sessions without deleting their state', () => {
    const archivedId = makeSessionId('codex', 'archived');
    const childId = makeSessionId('claude', 'child');
    const state = reduceAll(createInitialSessionState(), [
      upsert('thread-1'),
      upsert('archived', { isArchived: true }),
      upsert('child', { provider: 'claude', isTopLevel: false }),
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 100,
      },
      {
        type: 'turn-completed',
        sessionId: codexId,
        turnId: 'turn-a',
        completionId: 'done',
        timestamp: 110,
      },
    ]);

    expect(selectVisibleSessionSnapshots(state).map(({ id }) => id)).toEqual([codexId]);
    expect(selectSessionSnapshots(state).map(({ id }) => id)).toEqual([
      codexId,
      archivedId,
      childId,
    ]);
  });

  it('keeps provider health separate from session status and last completion', () => {
    let state = reduceAll(stateWithSession(), [
      {
        type: 'turn-started',
        sessionId: codexId,
        turnId: 'turn-a',
        timestamp: 100,
      },
      {
        type: 'turn-completed',
        sessionId: codexId,
        turnId: 'turn-a',
        completionId: 'done',
        timestamp: 110,
      },
      {
        type: 'provider-health',
        provider: 'codex',
        status: 'unavailable',
        timestamp: 120,
      },
    ]);
    expect(selectSession(state, codexId)).toMatchObject({
      status: 'unread',
      completionId: 'done',
    });
    expect(selectProviderHealth(state, 'codex')).toEqual({
      status: 'unavailable',
      updatedAt: 120,
    });
    expect(selectVisibleSessionSnapshots(state)).toEqual([
      expect.objectContaining({
        id: codexId,
        status: 'unavailable',
        completionId: 'done',
      }),
    ]);

    state = reduceSessionState(state, {
      type: 'provider-health',
      provider: 'codex',
      status: 'available',
      timestamp: 119,
    });
    expect(selectProviderHealth(state, 'codex')).toEqual({
      status: 'unavailable',
      updatedAt: 120,
    });
  });

  it('overlays provider outages without losing visible session state', () => {
    const workingId = makeSessionId('codex', 'working');
    const waitingId = makeSessionId('codex', 'waiting');
    const errorId = makeSessionId('codex', 'error');
    const unreadId = makeSessionId('codex', 'unread');
    const idleId = makeSessionId('codex', 'idle');
    let state = reduceAll(createInitialSessionState(), [
      upsert('working'),
      upsert('waiting'),
      upsert('error'),
      upsert('unread'),
      upsert('idle'),
      {
        type: 'turn-started',
        sessionId: workingId,
        turnId: 'working-turn',
        timestamp: 100,
      },
      {
        type: 'turn-started',
        sessionId: waitingId,
        turnId: 'waiting-turn',
        timestamp: 100,
      },
      {
        type: 'input-requested',
        sessionId: waitingId,
        turnId: 'waiting-turn',
        callId: 'wait',
        timestamp: 110,
      },
      {
        type: 'turn-started',
        sessionId: errorId,
        turnId: 'error-turn',
        timestamp: 100,
      },
      {
        type: 'turn-failed',
        sessionId: errorId,
        turnId: 'error-turn',
        timestamp: 110,
      },
      {
        type: 'turn-started',
        sessionId: unreadId,
        turnId: 'unread-turn',
        timestamp: 100,
      },
      {
        type: 'turn-completed',
        sessionId: unreadId,
        turnId: 'unread-turn',
        completionId: 'unread-completion',
        timestamp: 110,
      },
      {
        type: 'provider-health',
        provider: 'codex',
        status: 'unavailable',
        timestamp: 200,
      },
    ]);

    expect(
      Object.fromEntries(
        selectVisibleSessionSnapshots(state).map(({ id, status }) => [id, status]),
      ),
    ).toEqual({
      [workingId]: 'unavailable',
      [waitingId]: 'unavailable',
      [errorId]: 'unavailable',
      [unreadId]: 'unavailable',
    });
    expect(selectSession(state, workingId)?.status).toBe('working');
    expect(selectSession(state, waitingId)?.status).toBe('needs-input');
    expect(selectSession(state, errorId)?.status).toBe('error');
    expect(selectSession(state, unreadId)).toMatchObject({
      status: 'unread',
      completionId: 'unread-completion',
    });

    state = reduceSessionState(state, {
      type: 'provider-health',
      provider: 'codex',
      status: 'error',
      timestamp: 210,
    });
    expect(
      selectVisibleSessionSnapshots(state).every(({ status }) => status === 'unavailable'),
    ).toBe(true);

    state = reduceSessionState(state, {
      type: 'provider-health',
      provider: 'codex',
      status: 'available',
      timestamp: 220,
    });
    expect(
      Object.fromEntries(
        selectVisibleSessionSnapshots(state).map(({ id, status }) => [id, status]),
      ),
    ).toEqual({
      [workingId]: 'working',
      [waitingId]: 'needs-input',
      [errorId]: 'error',
      [unreadId]: 'unread',
    });
    expect(selectVisibleSessionSnapshots(state).map(({ id }) => id)).not.toContain(idleId);
  });
});

describe('event validation', () => {
  it('accepts the bounded event contract and rejects unsupported or malformed values', () => {
    expect(
      isSessionEvent({
        type: 'turn-completed',
        sessionId: claudeId,
        turnId: 'turn-1',
        completionId: 'completion-1',
        timestamp: 1,
      }),
    ).toBe(true);
    expect(
      isSessionEvent({
        type: 'upsert',
        provider: 'codex',
        nativeSessionId: 'thread-1',
        surface: 'desktop',
        title: 'session',
        isTopLevel: true,
        isArchived: false,
        canOpen: true,
        updatedAt: 1,
      }),
    ).toBe(true);
    expect(isSessionEvent({ type: 'stop', sessionId: codexId, timestamp: 1 })).toBe(false);
    expect(
      isSessionEvent({
        type: 'turn-started',
        sessionId: codexId,
        turnId: '',
        timestamp: 1,
      }),
    ).toBe(false);
    expect(isSessionEvent(null)).toBe(false);
  });
});

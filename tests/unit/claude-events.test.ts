import { describe, expect, it } from 'vitest';

import { normalizeClaudeEvents } from '../../src/main/providers/claude/events';
import { MAX_INPUT_REQUESTS } from '../../src/main/sessions/persistence';
import type { HookJournalEvent } from '../../src/main/providers/hooks/hook-journal-reader';
import { createInitialSessionState, makeSessionId } from '../../src/shared/session';
import { reduceSessionState } from '../../src/main/sessions/reducer';

let sequence = 0;

function journal(
  eventName: HookJournalEvent['eventName'],
  overrides: Partial<HookJournalEvent> = {},
): HookJournalEvent {
  sequence += 1;
  return {
    schemaVersion: 1,
    eventIdentity: `fixture:${sequence}`,
    provider: 'claude',
    eventName,
    sessionId: 'native-1',
    timestamp: 1_700_000_000_000 + sequence,
    ...overrides,
  };
}

const sessionId = makeSessionId('claude', 'native-1');

function statusAfter(events: readonly HookJournalEvent[]): string[] {
  let state = reduceSessionState(createInitialSessionState(), {
    type: 'upsert',
    provider: 'claude',
    nativeSessionId: 'native-1',
    surface: 'desktop',
    title: 'project',
    isTopLevel: true,
    isArchived: false,
    canOpen: false,
    updatedAt: 1,
  });
  const statuses: string[] = [];
  for (const event of normalizeClaudeEvents(events, state.sessions)) {
    state = reduceSessionState(state, event);
    statuses.push(`${event.type}:${state.sessions[sessionId]!.status}`);
  }
  return statuses;
}

describe('claude event normalization', () => {
  it('maps a prompt, a permission wait, approval, and completion onto the reducer', () => {
    expect(
      statusAfter([
        journal('SessionStart'),
        journal('UserPromptSubmit'),
        journal('PreToolUse'),
        journal('PermissionRequest', { toolCallId: 'call-1' }),
        journal('Notification', { notificationType: 'permission_prompt' }),
        journal('PostToolUse', { toolCallId: 'call-1' }),
        journal('Stop', { stopHookActive: false }),
      ]),
    ).toEqual([
      'turn-started:working',
      'activity:working',
      'input-requested:needs-input',
      // The prompt notification is supplementary while a request is open.
      'input-resolved:working',
      'activity:working',
      'turn-completed:unread',
    ]);
  });

  it('reports progress instead of a wait once a turn has issued the persisted request bound', () => {
    const events = normalizeClaudeEvents(
      [
        journal('UserPromptSubmit'),
        ...Array.from({ length: MAX_INPUT_REQUESTS + 5 }, (_, index) => [
          journal('PermissionRequest', { toolCallId: `call-${index}` }),
          journal('PostToolUse', { toolCallId: `call-${index}` }),
        ]).flat(),
        journal('UserPromptSubmit'),
        journal('PermissionRequest', { toolCallId: 'fresh' }),
      ],
      {},
    );
    const requested = events.filter((event) => event.type === 'input-requested');
    expect(requested).toHaveLength(MAX_INPUT_REQUESTS + 1);
    expect(requested.at(-1)).toMatchObject({ callId: 'fresh' });
    // Beyond the bound each prompt still counts as progress.
    expect(events.filter((event) => event.type === 'activity').length).toBeGreaterThan(
      MAX_INPUT_REQUESTS + 5,
    );
  });

  it('treats questions and elicitations as waiting until answered', () => {
    const events = normalizeClaudeEvents(
      [
        journal('UserPromptSubmit'),
        journal('PreToolUse', { toolName: 'AskUserQuestion', toolCallId: 'q-1' }),
        journal('PostToolUse', { toolName: 'AskUserQuestion', toolCallId: 'q-1' }),
        journal('Elicitation', { elicitationId: 'e-1' }),
        journal('ElicitationResult', { elicitationId: 'e-1' }),
        journal('Notification', { notificationType: 'elicitation_dialog' }),
        journal('Notification', { notificationType: 'elicitation_complete' }),
      ],
      {},
    );
    expect(events.map((event) => `${event.type}:${'callId' in event ? event.callId : ''}`)).toEqual(
      [
        'turn-started:',
        'input-requested:q-1',
        'input-resolved:q-1',
        'activity:',
        'input-requested:e-1',
        'input-resolved:e-1',
        expect.stringMatching(/^input-requested:notification:/u),
        expect.stringMatching(/^input-resolved:notification:/u),
      ],
    );
  });

  it('never completes a turn from a subagent stop, a continuing stop hook, or without a turn', () => {
    const events = normalizeClaudeEvents(
      [
        journal('Stop'),
        journal('UserPromptSubmit'),
        journal('Stop', { isSubagent: true }),
        journal('Stop', { stopHookActive: true }),
        journal('PostToolUseFailure', { toolCallId: 'boom' }),
        journal('StopFailure'),
        journal('PostToolUse'),
      ],
      {},
    );
    expect(events.map((event) => event.type)).toEqual([
      'activity',
      'turn-started',
      'activity',
      'activity',
      'activity',
      'turn-failed',
      'activity',
    ]);
    expect(events.filter((event) => event.type === 'turn-completed')).toEqual([]);
    expect(statusAfter([journal('UserPromptSubmit'), journal('StopFailure')])).toEqual([
      'turn-started:working',
      'turn-failed:error',
    ]);
  });

  it('gives every completion a deterministic id and starts a new turn cleanly', () => {
    const first = normalizeClaudeEvents([journal('UserPromptSubmit'), journal('Stop')], {});
    const replay = normalizeClaudeEvents(
      [journal('UserPromptSubmit'), journal('Stop')].map((event, index) => ({
        ...event,
        timestamp: first[index]!.timestamp,
      })),
      {},
    );
    expect(first[1]).toMatchObject({ type: 'turn-completed' });
    expect(replay[1]).toEqual(first[1]);
    expect(
      statusAfter([
        journal('UserPromptSubmit'),
        journal('Stop'),
        journal('UserPromptSubmit'),
        journal('PermissionRequest', { toolCallId: 'c' }),
        journal('UserPromptSubmit'),
      ]),
    ).toEqual([
      'turn-started:working',
      'turn-completed:unread',
      'turn-started:working',
      'input-requested:needs-input',
      'turn-started:working',
    ]);
  });

  it('resumes a persisted turn and its open request across reads', () => {
    const state = reduceSessionState(
      reduceSessionState(
        reduceSessionState(createInitialSessionState(), {
          type: 'upsert',
          provider: 'claude',
          nativeSessionId: 'native-1',
          surface: 'cli',
          title: 'project',
          isTopLevel: true,
          isArchived: false,
          canOpen: false,
          updatedAt: 1,
        }),
        { type: 'turn-started', sessionId, turnId: 'turn:1', timestamp: 10 },
      ),
      { type: 'input-requested', sessionId, turnId: 'turn:1', callId: 'open', timestamp: 11 },
    );
    const events = normalizeClaudeEvents(
      [journal('PostToolUse', { toolCallId: 'open' }), journal('Stop')],
      state.sessions,
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'input-resolved', turnId: 'turn:1', callId: 'open' }),
      expect.objectContaining({ type: 'activity', turnId: 'turn:1' }),
      expect.objectContaining({ type: 'turn-completed', turnId: 'turn:1' }),
    ]);
  });

  it('keeps waiting for a subagent permission, separates interleaved sessions, and ignores tombstones', () => {
    expect(
      statusAfter([
        journal('UserPromptSubmit'),
        journal('PermissionRequest', { toolCallId: 'sub-1', isSubagent: true }),
      ]),
    ).toEqual(['turn-started:working', 'input-requested:needs-input']);

    const interleaved = normalizeClaudeEvents(
      [
        journal('UserPromptSubmit'),
        journal('UserPromptSubmit', { sessionId: 'native-2' }),
        journal('Stop', { sessionId: 'native-2' }),
        journal('Stop'),
      ],
      {},
    );
    expect(interleaved.map((event) => `${event.type}@${event.sessionId}`)).toEqual([
      'turn-started@claude:native-1',
      'turn-started@claude:native-2',
      'turn-completed@claude:native-2',
      'turn-completed@claude:native-1',
    ]);

    const settled = reduceSessionState(
      reduceSessionState(
        reduceSessionState(
          reduceSessionState(createInitialSessionState(), {
            type: 'upsert',
            provider: 'claude',
            nativeSessionId: 'native-1',
            surface: 'cli',
            title: 'project',
            isTopLevel: true,
            isArchived: false,
            canOpen: false,
            updatedAt: 1,
          }),
          { type: 'turn-started', sessionId, turnId: 'turn:1', timestamp: 10 },
        ),
        { type: 'input-requested', sessionId, turnId: 'turn:1', callId: 'done', timestamp: 11 },
      ),
      { type: 'input-resolved', sessionId, turnId: 'turn:1', callId: 'done', timestamp: 12 },
    );
    const late = normalizeClaudeEvents(
      [journal('PostToolUse', { toolCallId: 'done' }), journal('Stop')],
      settled.sessions,
    );
    expect(late.map((event) => event.type)).toEqual(['activity', 'turn-completed']);
  });

  it('treats a stop after a failure as activity and pins the parallel-batch resolution', () => {
    expect(
      normalizeClaudeEvents(
        [journal('UserPromptSubmit'), journal('StopFailure'), journal('Stop')],
        {},
      ).map((event) => event.type),
    ).toEqual(['turn-started', 'turn-failed', 'activity']);

    // Another tool finishing while tool A's permission is open counts as the
    // user acting, so A's wait resolves; the prompt notification would reopen it.
    const batch = normalizeClaudeEvents(
      [
        journal('UserPromptSubmit'),
        journal('PreToolUse'),
        journal('PreToolUse'),
        journal('PermissionRequest', { toolCallId: 'A' }),
        journal('PostToolUse', { toolCallId: 'B' }),
        journal('Notification', { notificationType: 'permission_prompt' }),
      ],
      {},
    );
    expect(batch.map((event) => `${event.type}:${'callId' in event ? event.callId : ''}`)).toEqual([
      'turn-started:',
      'activity:',
      'activity:',
      'input-requested:A',
      'input-resolved:A',
      'activity:',
      expect.stringMatching(/^input-requested:notification:/u),
    ]);
  });
});

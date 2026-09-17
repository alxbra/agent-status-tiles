import { describe, expect, it } from 'vitest';

import { normalizeClaudeEvents } from '../../src/main/providers/claude/events';
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
      'input-requested:needs-input',
      'input-resolved:needs-input',
      'input-resolved:working',
      'activity:working',
      'turn-completed:unread',
    ]);
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
});

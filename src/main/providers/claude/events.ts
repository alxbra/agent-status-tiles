import { makeSessionId, type SessionEvent, type SessionRecord } from '../../../shared/session';
import type { HookJournalEvent } from '../hooks/hook-journal-reader';

/** The lifecycle subset a Claude journal can produce; upserts come from discovery. */
export type ClaudeSessionEvent = Extract<
  SessionEvent,
  {
    type:
      | 'turn-started'
      | 'activity'
      | 'input-requested'
      | 'input-resolved'
      | 'turn-completed'
      | 'turn-failed';
  }
>;

interface TurnState {
  turnId: string | undefined;
  openRequests: Set<string>;
}

function seedState(record: SessionRecord | undefined): TurnState {
  const openRequests = new Set<string>();
  if (record?.activeTurnId !== undefined) {
    for (const [callId, request] of Object.entries(record.inputRequests)) {
      if (request.turnId === record.activeTurnId && request.resolvedAt === undefined) {
        openRequests.add(callId);
      }
    }
  }
  return { turnId: record?.activeTurnId, openRequests };
}

/**
 * Map hook journal records onto the shared lifecycle events.
 *
 * Claude hooks carry no turn identifier, so a turn is keyed by the receipt
 * time of the prompt that started it and every later record of the session
 * attaches to the newest turn. Waiting comes from permission requests, the
 * question tools, and elicitations; any later progress on the same turn
 * resolves what is still open. `Stop` completes a turn only when no other
 * stop hook is continuing it and the record is not from a subagent, because
 * a subagent stopping never means the parent finished. `StopFailure` fails
 * the turn. Ordinary tool failures are activity, never a red session.
 */
export function normalizeClaudeEvents(
  events: readonly HookJournalEvent[],
  sessions: Readonly<Record<string, SessionRecord>>,
): readonly ClaudeSessionEvent[] {
  const states = new Map<string, TurnState>();
  const output: ClaudeSessionEvent[] = [];
  for (const event of events) {
    const sessionId = makeSessionId('claude', event.sessionId);
    let state = states.get(sessionId);
    if (state === undefined) {
      state = seedState(Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined);
      states.set(sessionId, state);
    }
    const current = state;
    const timestamp = event.timestamp;
    const resolveAll = (): void => {
      if (current.turnId === undefined) return;
      for (const callId of current.openRequests) {
        output.push({
          type: 'input-resolved',
          sessionId,
          turnId: current.turnId,
          callId,
          timestamp,
        });
      }
      current.openRequests.clear();
    };
    const request = (callId: string): void => {
      if (current.turnId === undefined || current.openRequests.has(callId)) return;
      current.openRequests.add(callId);
      output.push({
        type: 'input-requested',
        sessionId,
        turnId: current.turnId,
        callId,
        timestamp,
      });
    };
    const resolve = (callId: string): void => {
      if (current.turnId === undefined) return;
      current.openRequests.delete(callId);
      output.push({ type: 'input-resolved', sessionId, turnId: current.turnId, callId, timestamp });
    };
    // A tool finishing answers its own request and any prompt notification,
    // which is never tied to one tool; other tools' requests stay open.
    const resolveOne = (callId: string | undefined): void => {
      if (callId === undefined || !current.openRequests.has(callId)) {
        resolveAll();
        return;
      }
      resolve(callId);
      for (const open of [...current.openRequests]) {
        if (open.startsWith('notification:')) resolve(open);
      }
    };
    const activity = (): void => {
      output.push({
        type: 'activity',
        sessionId,
        ...(current.turnId === undefined ? {} : { turnId: current.turnId }),
        timestamp,
      });
    };

    switch (event.eventName) {
      case 'UserPromptSubmit': {
        current.turnId = `turn:${timestamp}`;
        current.openRequests.clear();
        output.push({ type: 'turn-started', sessionId, turnId: current.turnId, timestamp });
        break;
      }
      case 'PreToolUse': {
        if (event.toolName !== undefined) {
          request(event.toolCallId ?? `question:${timestamp}`);
        } else {
          resolveAll();
          activity();
        }
        break;
      }
      case 'PermissionRequest': {
        request(event.toolCallId ?? `permission:${timestamp}`);
        break;
      }
      case 'Elicitation': {
        request(event.elicitationId ?? `elicitation:${timestamp}`);
        break;
      }
      case 'Notification': {
        if (
          event.notificationType === 'permission_prompt' ||
          event.notificationType === 'elicitation_dialog'
        ) {
          request(`notification:${timestamp}`);
        } else if (
          event.notificationType === 'elicitation_complete' ||
          event.notificationType === 'elicitation_response'
        ) {
          resolveAll();
        }
        break;
      }
      case 'PostToolUse': {
        resolveOne(event.toolCallId);
        activity();
        break;
      }
      case 'ElicitationResult': {
        resolveOne(event.elicitationId);
        break;
      }
      case 'PostToolUseFailure': {
        resolveAll();
        activity();
        break;
      }
      case 'Stop': {
        resolveAll();
        if (
          event.isSubagent === true ||
          event.stopHookActive === true ||
          current.turnId === undefined
        ) {
          activity();
          break;
        }
        output.push({
          type: 'turn-completed',
          sessionId,
          turnId: current.turnId,
          completionId: `${current.turnId}:${timestamp}`,
          timestamp,
        });
        current.turnId = undefined;
        break;
      }
      case 'StopFailure': {
        resolveAll();
        if (current.turnId === undefined) break;
        output.push({ type: 'turn-failed', sessionId, turnId: current.turnId, timestamp });
        current.turnId = undefined;
        break;
      }
      case 'SessionStart':
      case 'SessionEnd':
        break;
    }
  }
  return output;
}

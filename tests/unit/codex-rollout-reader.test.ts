import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CodexRolloutReader,
  MAX_EVENTS_PER_READ,
  MAX_LINE_BYTES,
  MAX_READ_BYTES,
  cursorKeyForPath,
} from '../../src/main/providers/codex';
import { reduceSessionState, selectSession } from '../../src/main/sessions/reducer';
import { createInitialSessionState, isSessionEvent } from '../../src/shared/session';
import type { FileCursor } from '../../src/shared/cursor';
import type {
  CodexRolloutEvent,
  CodexRolloutSource,
  CodexSessionQualification,
} from '../../src/main/providers/codex';

const SESSION_ID = '019f6b6d-644d-7701-8858-9da6837aaaaa';
const FIXTURE = path.join(process.cwd(), 'tests/fixtures/codex/basic-rollout.jsonl');
const CURRENT_FORMAT_FIXTURE = path.join(
  process.cwd(),
  'tests/fixtures/codex/current-format.jsonl',
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

async function testRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-status-codex-'));
  roots.push(root);
  return root;
}

function record(
  type: string,
  payload: Record<string, unknown>,
  timestamp = '2026-09-15T10:00:00Z',
) {
  return JSON.stringify({ timestamp, type, payload });
}

function event(type: string, turnId?: string, extra: Record<string, unknown> = {}) {
  return record('event_msg', { type, ...(turnId ? { turn_id: turnId } : {}), ...extra });
}

function sessionMeta(id = SESSION_ID, extra: Record<string, unknown> = {}) {
  return record('session_meta', {
    id,
    source: 'cli',
    cwd: '/Users/example/private-project',
    ...extra,
  });
}

function response(type: string, payload: Record<string, unknown>) {
  return record('response_item', { type, ...payload });
}

async function writeLines(file: string, lines: string[]): Promise<void> {
  await writeFile(file, `${lines.join('\n')}\n`);
}

function eventTypes(events: readonly CodexRolloutEvent[]): string[] {
  return events.map(({ event: emitted }) => emitted.type);
}

function sourceFor(
  file: string,
  nativeSessionId = SESSION_ID,
  overrides: Partial<CodexSessionQualification> = {},
): CodexRolloutSource {
  return {
    path: file,
    session: {
      nativeSessionId,
      surface: 'cli',
      isTopLevel: true,
      inputRequests: {},
      ...overrides,
    },
  };
}

describe('CodexRolloutReader', () => {
  it('projects only explicit rollout paths and marks first-install history as baseline', async () => {
    const root = await testRoot();
    const nested = path.join(root, '2026', '09', '15');
    await mkdir(nested, { recursive: true });
    const file = path.join(nested, `rollout-${SESSION_ID}.jsonl`);
    await writeFile(file, await readFile(FIXTURE));

    const reader = new CodexRolloutReader(root);
    expect(await reader.inspectSessionMeta(file)).toEqual({ nativeSessionId: SESSION_ID });
    expect(await reader.captureRolloutEndOffset(file)).toBe((await readFile(file)).byteLength);
    const empty = await reader.read([]);
    expect(empty.events).toEqual([]);
    expect(empty.diagnostics).toEqual([]);

    const result = await reader.read([sourceFor(file)], {}, { firstInstallBaseline: true });
    expect(eventTypes(result.events)).toEqual([
      'turn-started',
      'activity',
      'input-requested',
      'input-resolved',
      'activity',
      'activity',
      'turn-completed',
    ]);
    expect(result.events.every(({ baseline }) => baseline)).toBe(true);
    expect(result.events.every(({ event: emitted }) => isSessionEvent(emitted))).toBe(true);
    expect(result.events[0]).toMatchObject({
      nativeSessionId: SESSION_ID,
      surface: 'cli',
      isTopLevel: true,
      event: { type: 'turn-started', sessionId: `codex:${SESSION_ID}`, turnId: 'turn-basic' },
    });
    expect(result.events.at(-1)?.event).toMatchObject({
      type: 'turn-completed',
      completionId: expect.stringMatching(/^codex:[0-9a-f]{64}$/),
    });
    const key = cursorKeyForPath(root, file);
    expect(Object.keys(result.cursors)).toEqual([key]);
    expect(key).toBe('codex:2026/09/15/rollout-019f6b6d-644d-7701-8858-9da6837aaaaa.jsonl');
    expect(result.cursors[key].offset).toBe((await readFile(file)).byteLength);

    const serialized = JSON.stringify(result.events);
    expect(serialized).not.toContain('PRIVATE_TOOL_ARGUMENTS_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('PRIVATE_PROMPT_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('PRIVATE_ANSWER_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('PRIVATE_ERROR_BODY_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('PRIVATE_TRANSCRIPT_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('PRIVATE_FINAL_SHOULD_NOT_LEAK');
  });

  it('skips observed current-version telemetry while projecting lifecycle records', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeFile(file, await readFile(CURRENT_FORMAT_FIXTURE));
    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);
    expect(eventTypes(result.events)).toEqual(['turn-started', 'turn-completed']);
    expect(result.diagnostics).toEqual([]);
  });

  it('discards invalid identifiers instead of emitting reducer-invalid events', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(),
      event('task_started', '   '),
      event('task_started', 'x'.repeat(257)),
      event('task_started', '\u0080'),
    ]);
    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);

    expect(result.events).toEqual([]);
    expect(result.events.every(({ event: emitted }) => isSessionEvent(emitted))).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'missing-turn-id',
      'missing-turn-id',
      'missing-turn-id',
    ]);
  });

  it('quarantines records when session metadata is missing or has no identity', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      event('task_started', 'before-missing-meta'),
      record('session_meta', { source: 'cli' }),
      event('task_started', 'after-missing-meta'),
    ]);
    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);

    expect(result.events).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain('missing-session-id');
  });

  it('replays a partial line, then advances exactly once when completed', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const start = `${sessionMeta()}\n${event('task_started', 'turn-partial')}\n`;
    const complete = event('task_complete', 'turn-partial');
    await writeFile(file, start + complete.slice(0, Math.floor(complete.length / 2)));
    const reader = new CodexRolloutReader(root);

    const first = await reader.read([sourceFor(file)]);
    const key = cursorKeyForPath(root, file);
    expect(eventTypes(first.events)).toEqual(['turn-started']);
    expect(first.cursors[key].offset).toBe(Buffer.byteLength(start));

    await appendFile(file, `${complete.slice(Math.floor(complete.length / 2))}\n`);
    const second = await reader.read([sourceFor(file)], first.cursors);
    expect(eventTypes(second.events)).toEqual(['turn-completed']);
    expect(second.cursors[key].offset).toBe((await readFile(file)).byteLength);

    const replay = await reader.read([sourceFor(file)], second.cursors);
    expect(replay.events).toEqual([]);
  });

  it('resets on truncation and replacement, and rejects symlinks and paths outside root', async () => {
    const root = await testRoot();
    const outside = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [sessionMeta(), event('task_started', 'old-turn-with-long-id')]);
    const reader = new CodexRolloutReader(root);
    const first = await reader.read([sourceFor(file)]);
    const key = cursorKeyForPath(root, file);

    await writeFile(file, `${sessionMeta()}\n${event('task_started', 'new-turn')}\n`);
    const truncated = await reader.read([sourceFor(file)], first.cursors);
    expect(truncated.diagnostics.map(({ code }) => code)).toContain('file-reset');
    expect(
      truncated.events.some(
        ({ event: emitted }) => emitted.type === 'turn-started' && emitted.turnId === 'new-turn',
      ),
    ).toBe(true);

    const replacement = `${sessionMeta()}\n${event('task_started', 'replacement-turn')}\n`;
    const replacementFile = `${file}.new`;
    await writeFile(replacementFile, replacement);
    await rename(replacementFile, file);
    const replaced = await reader.read([sourceFor(file)], truncated.cursors);
    expect(replaced.diagnostics.map(({ code }) => code)).toContain('file-reset');
    expect(
      replaced.events.some(
        ({ event: emitted }) =>
          emitted.type === 'turn-started' && emitted.turnId === 'replacement-turn',
      ),
    ).toBe(true);

    const link = path.join(root, 'link.jsonl');
    await writeFile(path.join(outside, 'real.jsonl'), `${sessionMeta()}\n`);
    await symlink(path.join(outside, 'real.jsonl'), link);
    const rejected = await reader.read([
      sourceFor(link),
      sourceFor(path.join(outside, 'real.jsonl')),
    ]);
    expect(rejected.diagnostics.map(({ code }) => code)).toEqual([
      'symlink-rejected',
      'path-outside-root',
    ]);
    expect(rejected.cursors[key]).toBeUndefined();
  });

  it('skips oversized and invalid lines while retaining bounded diagnostics', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const oversized = `${'x'.repeat(MAX_LINE_BYTES + 1)}\n`;
    await writeFile(file, `${oversized}{not-json}\n${event('task_started', 'after-invalid')}\n`);

    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);
    expect(eventTypes(result.events)).toEqual(['turn-started']);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['oversized-line', 'invalid-json']);
    expect(result.diagnostics.every(({ pathKey }) => /^[0-9a-f]{64}$/.test(pathKey))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('x'.repeat(128));
  });

  it('reads a current-format status record above one MiB without retaining private padding', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const privatePadding = 'PRIVATE_PADDING_'.repeat(120_000);
    await writeLines(file, [
      sessionMeta(),
      event('task_started', 'large-turn', { private_padding: privatePadding }),
    ]);
    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);
    expect(eventTypes(result.events)).toEqual(['turn-started']);
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PADDING_');
  });

  it('returns a continuation cursor when a read reaches its event budget', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const lines = [
      sessionMeta(),
      ...Array.from({ length: MAX_EVENTS_PER_READ + 1 }, (_, index) =>
        event('agent_message', 'turn-budget', { sequence: index }),
      ),
    ];
    await writeLines(file, lines);

    const reader = new CodexRolloutReader(root);
    const first = await reader.read([sourceFor(file)]);
    const key = cursorKeyForPath(root, file);
    expect(first.events).toHaveLength(MAX_EVENTS_PER_READ);
    expect(first.nextSourceIndex).toBe(0);
    expect(first.cursors[key].offset).toBeLessThan((await readFile(file)).byteLength);

    const second = await reader.read([sourceFor(file)], first.cursors);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.event).toMatchObject({ type: 'activity', turnId: 'turn-budget' });
  });

  it('keeps same-record input resolution within the event budget', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(),
      ...Array.from({ length: MAX_EVENTS_PER_READ - 2 }, (_, index) =>
        event('agent_message', 'turn-budget-input', { sequence: index }),
      ),
      response('function_call_output', { call_id: 'budget-call', turn_id: 'turn-budget-input' }),
      response('function_call', {
        name: 'request_user_input',
        call_id: 'budget-call',
        turn_id: 'turn-budget-input',
      }),
    ]);
    const reader = new CodexRolloutReader(root);
    const first = await reader.read([sourceFor(file)]);
    expect(first.events).toHaveLength(MAX_EVENTS_PER_READ);
    expect(first.events.length).toBeLessThanOrEqual(MAX_EVENTS_PER_READ);
    expect(first.nextSourceIndex).toBeUndefined();
    expect(eventTypes(first.events.slice(-2))).toEqual(['input-requested', 'input-resolved']);
  });

  it('keeps the initial EOF baseline across event-budget continuations', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(),
      ...Array.from({ length: MAX_EVENTS_PER_READ + 1 }, (_, index) =>
        event('agent_message', 'turn-baseline', { sequence: index }),
      ),
    ]);
    const reader = new CodexRolloutReader(root);
    const source = sourceFor(file);
    const first = await reader.read([source], {}, { firstInstallBaseline: true });
    const key = cursorKeyForPath(root, file);
    expect(first.events.every(({ baseline }) => baseline)).toBe(true);
    expect(first.cursors[key].baselineUntilOffset).toBeGreaterThan(first.cursors[key].offset);

    const second = await new CodexRolloutReader(root).read([source], first.cursors);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.baseline).toBe(true);
    expect(second.cursors[key].baselineUntilOffset).toBeUndefined();

    await appendFile(file, `${event('agent_message', 'turn-live')}\n`);
    const third = await new CodexRolloutReader(root).read([source], second.cursors);
    expect(third.events).toHaveLength(1);
    expect(third.events[0]?.baseline).toBe(false);
  });

  it('caps total bytes read and lets the caller continue with the returned cursor', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const lines = [
      sessionMeta(),
      ...Array.from({ length: 600 }, () =>
        response('message', { content: 'synthetic-content-that-is-not-retained-'.repeat(380) }),
      ),
    ];
    await writeLines(file, lines);
    const totalBytes = (await readFile(file)).byteLength;
    expect(totalBytes).toBeGreaterThan(MAX_READ_BYTES);

    const reader = new CodexRolloutReader(root);
    const first = await reader.read([sourceFor(file)]);
    const key = cursorKeyForPath(root, file);
    expect(first.nextSourceIndex).toBe(0);
    expect(first.cursors[key].offset).toBeLessThan(totalBytes);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.length).toBeLessThan(lines.length - 1);

    const second = await reader.read([sourceFor(file)], first.cursors);
    expect(second.events.length).toBeGreaterThan(0);
  });

  it('continues discarding an oversized unterminated line across batches', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const oversized = 'x'.repeat(MAX_READ_BYTES + MAX_LINE_BYTES + 128);
    await writeFile(file, oversized);
    const source = sourceFor(file);
    const reader = new CodexRolloutReader(root);
    const first = await reader.read([source]);
    const key = cursorKeyForPath(root, file);
    expect(first.events).toEqual([]);
    expect(first.cursors[key].isDiscardingOversizedLine).toBe(true);
    expect(first.cursors[key].offset).toBe(MAX_READ_BYTES);

    await appendFile(file, `\n${event('task_started', 'after-oversized')}\n`);
    const second = await reader.read([source], first.cursors);
    expect(eventTypes(second.events)).toEqual(['turn-started']);
    expect(second.cursors[key].isDiscardingOversizedLine).toBeUndefined();
  });

  it('keeps input correlation scoped to each file and supports output-before-request', async () => {
    const root = await testRoot();
    const firstFile = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const secondId = '019f6b6d-644d-7701-8858-9da6837aaaab';
    const secondFile = path.join(root, `rollout-${secondId}.jsonl`);
    await writeLines(firstFile, [
      sessionMeta(),
      event('task_started', 'turn-first'),
      response('function_call_output', {
        call_id: 'same-call',
        turn_id: 'turn-first',
        output: 'private',
      }),
      response('function_call', {
        name: 'request_user_input',
        call_id: 'same-call',
        turn_id: 'turn-first',
        arguments: 'private',
      }),
    ]);
    await writeLines(secondFile, [
      sessionMeta(secondId),
      event('task_started', 'turn-second'),
      response('function_call', {
        name: 'request_user_input',
        call_id: 'same-call',
        turn_id: 'turn-second',
      }),
      response('function_call_output', { call_id: 'same-call', turn_id: 'turn-second' }),
    ]);

    const result = await new CodexRolloutReader(root).read([
      sourceFor(firstFile),
      sourceFor(secondFile, secondId),
    ]);
    const inputs = result.events
      .map(({ event: emitted }) => emitted)
      .filter((emitted) => emitted.type === 'input-requested' || emitted.type === 'input-resolved');
    expect(inputs).toHaveLength(4);
    expect(inputs.map(({ sessionId }) => sessionId)).toEqual([
      `codex:${SESSION_ID}`,
      `codex:${SESSION_ID}`,
      `codex:${secondId}`,
      `codex:${secondId}`,
    ]);
    expect(inputs.map(({ type }) => type)).toEqual([
      'input-requested',
      'input-resolved',
      'input-requested',
      'input-resolved',
    ]);
  });

  it('keeps output-before-request resolution ordered for the shared reducer', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(),
      record(
        'event_msg',
        { type: 'task_started', turn_id: 'turn-reordered' },
        '2026-09-15T10:00:01Z',
      ),
      record(
        'response_item',
        { type: 'function_call_output', call_id: 'reordered-call', turn_id: 'turn-reordered' },
        '2026-09-15T10:00:01.500Z',
      ),
      record(
        'response_item',
        {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'reordered-call',
          turn_id: 'turn-reordered',
        },
        '2026-09-15T10:00:02Z',
      ),
    ]);

    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);
    let state = reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'codex',
      nativeSessionId: SESSION_ID,
      surface: 'cli',
      title: 'Qualified session',
      isTopLevel: true,
      isArchived: false,
      canOpen: true,
      updatedAt: 0,
    });
    state = reduceSessionState(state, {
      type: 'provider-health',
      provider: 'codex',
      status: 'available',
      timestamp: 1,
    });
    for (const { event: emitted } of result.events) {
      state = reduceSessionState(state, emitted);
    }

    expect(state.sessions[`codex:${SESSION_ID}`]).toMatchObject({
      inputRequests: {
        'reordered-call': {
          requestedAt: Date.parse('2026-09-15T10:00:02Z'),
          resolvedAt: Date.parse('2026-09-15T10:00:02Z'),
        },
      },
    });
    expect(selectSession(state, `codex:${SESSION_ID}`)?.status).toBe('working');
  });

  it('clamps a normal request-then-output pair before reducer replay', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(),
      record('event_msg', { type: 'task_started', turn_id: 'turn-skewed' }, '2026-09-15T10:00:01Z'),
      record(
        'response_item',
        {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'skewed-call',
          turn_id: 'turn-skewed',
        },
        '2026-09-15T10:00:03Z',
      ),
      record(
        'response_item',
        { type: 'function_call_output', call_id: 'skewed-call', turn_id: 'turn-skewed' },
        '2026-09-15T10:00:02Z',
      ),
    ]);
    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);
    let state = reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'codex',
      nativeSessionId: SESSION_ID,
      surface: 'cli',
      title: 'Qualified session',
      isTopLevel: true,
      isArchived: false,
      canOpen: true,
      updatedAt: 0,
    });
    for (const { event: emitted } of result.events) state = reduceSessionState(state, emitted);

    expect(state.sessions[`codex:${SESSION_ID}`]).toMatchObject({
      inputRequests: {
        'skewed-call': {
          requestedAt: Date.parse('2026-09-15T10:00:03Z'),
          resolvedAt: Date.parse('2026-09-15T10:00:03Z'),
        },
      },
    });
    expect(selectSession(state, `codex:${SESSION_ID}`)?.status).toBe('working');
  });

  it('clamps a seeded unresolved request after a restart', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const turnStartedAt = Date.parse('2026-09-15T10:00:01Z');
    const requestedAt = Date.parse('2026-09-15T10:00:03Z');
    await writeLines(file, [
      sessionMeta(),
      record(
        'response_item',
        { type: 'function_call_output', call_id: 'restart-skewed', turn_id: 'turn-restart' },
        '2026-09-15T10:00:02Z',
      ),
    ]);
    const result = await new CodexRolloutReader(root).read([
      sourceFor(file, SESSION_ID, {
        activeTurnId: 'turn-restart',
        turnKey: { turnId: 'turn-restart', timestamp: turnStartedAt },
        inputRequests: {
          'restart-skewed': { turnId: 'turn-restart', requestedAt },
        },
      }),
    ]);
    let state = reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'codex',
      nativeSessionId: SESSION_ID,
      surface: 'cli',
      title: 'Qualified session',
      isTopLevel: true,
      isArchived: false,
      canOpen: true,
      updatedAt: 0,
    });
    state = reduceSessionState(state, {
      type: 'turn-started',
      sessionId: `codex:${SESSION_ID}`,
      turnId: 'turn-restart',
      timestamp: turnStartedAt,
    });
    state = reduceSessionState(state, {
      type: 'input-requested',
      sessionId: `codex:${SESSION_ID}`,
      turnId: 'turn-restart',
      callId: 'restart-skewed',
      timestamp: requestedAt,
    });
    for (const { event: emitted } of result.events) state = reduceSessionState(state, emitted);

    expect(state.sessions[`codex:${SESSION_ID}`]).toMatchObject({
      inputRequests: {
        'restart-skewed': { requestedAt, resolvedAt: requestedAt },
      },
    });
    expect(selectSession(state, `codex:${SESSION_ID}`)?.status).toBe('working');
  });

  it('ignores stale requests and pre-start terminals before resolving the current wait', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const turnStartedAt = Date.parse('2026-09-15T10:00:01Z');
    await writeLines(file, [
      sessionMeta(),
      record(
        'event_msg',
        { type: 'task_complete', turn_id: 'turn-current' },
        '2026-09-15T10:00:00Z',
      ),
      record(
        'response_item',
        {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'reused-call',
          turn_id: 'turn-current',
        },
        '2026-09-15T10:00:02Z',
      ),
      record(
        'response_item',
        {
          type: 'function_call',
          name: 'request_user_input',
          call_id: 'reused-call',
          turn_id: 'turn-old',
        },
        '2026-09-15T10:00:03Z',
      ),
      record(
        'response_item',
        { type: 'function_call_output', call_id: 'reused-call', turn_id: 'turn-current' },
        '2026-09-15T10:00:04Z',
      ),
    ]);
    const result = await new CodexRolloutReader(root).read([
      sourceFor(file, SESSION_ID, {
        activeTurnId: 'turn-current',
        turnKey: { turnId: 'turn-current', timestamp: turnStartedAt },
      }),
    ]);

    expect(eventTypes(result.events)).toEqual(['input-requested', 'input-resolved']);
    expect(result.diagnostics).toEqual([]);
    let state = reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'codex',
      nativeSessionId: SESSION_ID,
      surface: 'cli',
      title: 'Qualified session',
      isTopLevel: true,
      isArchived: false,
      canOpen: true,
      updatedAt: 0,
    });
    state = reduceSessionState(state, {
      type: 'turn-started',
      sessionId: `codex:${SESSION_ID}`,
      turnId: 'turn-current',
      timestamp: turnStartedAt,
    });
    for (const { event: emitted } of result.events) state = reduceSessionState(state, emitted);

    expect(state.sessions[`codex:${SESSION_ID}`]).toMatchObject({
      activeTurnId: 'turn-current',
      inputRequests: { 'reused-call': { resolvedAt: Date.parse('2026-09-15T10:00:04Z') } },
    });
    expect(selectSession(state, `codex:${SESSION_ID}`)?.status).toBe('working');
  });

  it('seeds unresolved input correlation from the qualified session record', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(),
      response('function_call_output', { call_id: 'restart-call', output: 'private' }),
    ]);
    const result = await new CodexRolloutReader(root).read([
      sourceFor(file, SESSION_ID, {
        activeTurnId: 'turn-restart',
        inputRequests: {
          'restart-call': { turnId: 'turn-restart', requestedAt: 1_757_938_800_000 },
        },
      }),
    ]);
    expect(result.events.map(({ event: emitted }) => emitted)).toEqual([
      {
        type: 'input-resolved',
        sessionId: `codex:${SESSION_ID}`,
        turnId: 'turn-restart',
        callId: 'restart-call',
        timestamp: Date.parse('2026-09-15T10:00:00Z'),
      },
    ]);
  });

  it('does not replace current-turn context for duplicate or stale turn starts', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const currentStartedAt = '2026-09-15T10:00:00Z';
    await writeLines(file, [
      sessionMeta(),
      record(
        'event_msg',
        { type: 'task_started', turn_id: 'turn-current' },
        '2026-09-15T10:00:01Z',
      ),
      record('event_msg', { type: 'task_started', turn_id: 'turn-old' }, '2026-09-15T09:59:59Z'),
      response('function_call_output', { call_id: 'restart-call', output: 'private' }),
    ]);
    const result = await new CodexRolloutReader(root).read([
      sourceFor(file, SESSION_ID, {
        activeTurnId: 'turn-current',
        turnKey: { turnId: 'turn-current', timestamp: Date.parse(currentStartedAt) },
        inputRequests: {
          'restart-call': { turnId: 'turn-current', requestedAt: Date.parse(currentStartedAt) },
        },
      }),
    ]);
    expect(result.events.map(({ event: emitted }) => emitted)).toEqual([
      {
        type: 'input-resolved',
        sessionId: `codex:${SESSION_ID}`,
        turnId: 'turn-current',
        callId: 'restart-call',
        timestamp: Date.parse('2026-09-15T10:00:00Z'),
      },
    ]);
  });

  it('does not turn stream errors or silence into completion, but maps explicit failures', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(),
      event('task_started', 'turn-failure'),
      event('stream_error', 'turn-failure', { message: 'private transient failure' }),
      event('turn_aborted', 'turn-failure'),
    ]);
    const reader = new CodexRolloutReader(root);
    const result = await reader.read([sourceFor(file)]);
    expect(eventTypes(result.events)).toEqual(['turn-started', 'activity', 'turn-failed']);
    expect(result.events.some(({ event: emitted }) => emitted.type === 'turn-completed')).toBe(
      false,
    );

    await appendFile(file, `${event('turn_started', 'legacy-alias')}\n`);
    const alias = await reader.read([sourceFor(file)], result.cursors);
    expect(alias.events).toEqual([]);
    expect(alias.diagnostics.map(({ code }) => code)).toEqual(['unsupported-event']);
  });

  it('qualifies child sessions without allowing child completion to affect a parent', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta('019f6b6d-644d-7701-8858-9da6837aaaac', {
        forked_from_id: SESSION_ID,
        source: { subagent: { thread_spawn: {} } },
      }),
      event('task_started', 'child-turn'),
      event('task_complete', 'child-turn'),
    ]);
    const result = await new CodexRolloutReader(root).read([
      sourceFor(file, '019f6b6d-644d-7701-8858-9da6837aaaac', {
        isTopLevel: false,
        surface: 'desktop',
      }),
    ]);
    expect(result.events).toHaveLength(2);
    expect(
      result.events.every(
        ({ isTopLevel, nativeSessionId }) =>
          !isTopLevel && nativeSessionId === '019f6b6d-644d-7701-8858-9da6837aaaac',
      ),
    ).toBe(true);
    expect(result.events.map(({ event: emitted }) => emitted.sessionId)).toEqual([
      'codex:019f6b6d-644d-7701-8858-9da6837aaaac',
      'codex:019f6b6d-644d-7701-8858-9da6837aaaac',
    ]);
  });

  it('does not classify a forked-from top-level session as a child without a subagent marker', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(SESSION_ID, { forked_from_id: 'parent-session' }),
      event('task_started', 'forked-top-level'),
    ]);
    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);
    expect(result.diagnostics).toEqual([]);
    expect(result.events[0]).toMatchObject({ isTopLevel: true, event: { type: 'turn-started' } });
  });

  it('quarantines contradictory session metadata and retries from the beginning', async () => {
    const root = await testRoot();
    const mismatchFile = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const subagentFile = path.join(root, `rollout-${SESSION_ID}-subagent.jsonl`);
    await writeLines(mismatchFile, [
      sessionMeta('different-session'),
      event('task_started', 'must-not-emit'),
    ]);
    await writeLines(subagentFile, [
      sessionMeta(SESSION_ID, { thread_source: 'subagent' }),
      event('task_started', 'must-not-emit-either'),
    ]);
    const sources = [sourceFor(mismatchFile), sourceFor(subagentFile)];
    const reader = new CodexRolloutReader(root);
    const result = await reader.read(sources, {}, { firstInstallBaseline: true });
    expect(result.events).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'session-identity-mismatch',
      'qualification-mismatch',
    ]);
    for (const source of sources) {
      const key = cursorKeyForPath(root, source.path);
      expect(result.cursors[key]).toMatchObject({
        offset: 0,
        baselineUntilOffset: expect.any(Number),
      });
    }

    const retry = await reader.read(sources, result.cursors);
    expect(retry.events).toEqual([]);
    expect(retry.diagnostics.map(({ code }) => code)).toEqual([
      'session-identity-mismatch',
      'qualification-mismatch',
    ]);
  });

  it('does not let a late terminal event clear the qualified current turn', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(),
      event('task_complete', 'turn-old'),
      event('agent_message', 'turn-current'),
      event('task_complete'),
    ]);
    const result = await new CodexRolloutReader(root).read([
      sourceFor(file, SESSION_ID, { activeTurnId: 'turn-current' }),
    ]);
    const projected = result.events.map(({ event: emitted }) => emitted);
    expect(projected.map(({ type }) => type)).toEqual(['activity', 'turn-completed']);
    expect(projected[1]).toMatchObject({ turnId: 'turn-current' });
  });

  it('returns source progress so explicit source lists larger than the cap are not starved', async () => {
    const root = await testRoot();
    const files = await Promise.all(
      Array.from({ length: 129 }, async (_, index) => {
        const file = path.join(root, `rollout-${String(index).padStart(3, '0')}.jsonl`);
        await writeLines(file, [sessionMeta(`${SESSION_ID}-${String(index)}`)]);
        return file;
      }),
    );
    const sources = files.map((file, index) => sourceFor(file, `${SESSION_ID}-${String(index)}`));
    const reader = new CodexRolloutReader(root);
    const first = await reader.read(sources);
    expect(first.nextSourceIndex).toBe(128);
    expect(Object.keys(first.cursors)).toHaveLength(128);

    const second = await reader.read(sources, first.cursors, {
      sourceStart: first.nextSourceIndex,
    });
    expect(second.nextSourceIndex).toBeUndefined();
    expect(Object.keys(second.cursors)).toHaveLength(129);
    expect(second.cursors[cursorKeyForPath(root, files[128])]).toBeDefined();
  });

  it('fails closed for missing session or turn IDs and stops without mutating cursors', async () => {
    const root = await testRoot();
    const missingSessionFile = path.join(root, 'rollout-no-identity.jsonl');
    const missingTurnFile = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(missingSessionFile, [
      record('session_meta', { source: 'cli' }),
      event('task_started'),
    ]);
    await writeLines(missingTurnFile, [sessionMeta(), event('task_started')]);
    const reader = new CodexRolloutReader(root);
    const invalidSource = sourceFor(missingSessionFile, '') as unknown as CodexRolloutSource;
    const result = await reader.read([invalidSource, sourceFor(missingTurnFile)]);
    expect(result.events).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'missing-session-id',
      'missing-turn-id',
    ]);

    reader.stop();
    await appendFile(missingSessionFile, `${event('task_started', 'stopped-turn')}\n`);
    const stopped = await reader.read([invalidSource], result.cursors);
    expect(stopped.events).toEqual([]);
    expect(stopped.cursors).toEqual(result.cursors);
    reader.start();
    const resumed = await reader.read([invalidSource], result.cursors);
    expect(resumed.events).toEqual([]);
  });

  it('fails closed for a missing input-call ID', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [
      sessionMeta(),
      event('task_started', 'turn-missing-call'),
      response('function_call_output', { output: 'private' }),
    ]);
    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);
    expect(eventTypes(result.events)).toEqual(['turn-started']);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['missing-call-id']);
  });

  it('does not return an uninitialized cursor when an explicit file is unavailable', async () => {
    const root = await testRoot();
    const file = path.join(root, `missing-${SESSION_ID}.jsonl`);
    const result = await new CodexRolloutReader(root).read([sourceFor(file)]);
    expect(result.events).toEqual([]);
    expect(result.cursors).toEqual({});
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['missing-file']);
  });

  it('bounds and sanitizes caller-provided cursors', async () => {
    const root = await testRoot();
    const file = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    await writeLines(file, [sessionMeta(), event('task_started', 'turn-cursor')]);
    const cursor: FileCursor = {
      offset: 0,
      identity: `${'x'.repeat(2_000)}`,
      baselineUntilOffset: 2_000,
      isDiscardingOversizedLine: true,
    };
    const result = await new CodexRolloutReader(root).read([sourceFor(file)], {
      [path.join(root, 'absolute-key.jsonl')]: cursor,
      [cursorKeyForPath(root, file)]: cursor,
    });
    expect(result.events[0]?.nativeSessionId).toBe(SESSION_ID);
    expect(result.cursors[cursorKeyForPath(root, file)].identity.length).toBeLessThanOrEqual(512);
    expect(result.cursors[path.join(root, 'absolute-key.jsonl')]).toBeUndefined();
  });

  it('replays multiple files only through externally captured fixed EOFs', async () => {
    const root = await testRoot();
    const firstFile = path.join(root, 'rollout-' + SESSION_ID + '.jsonl');
    const secondId = '019f6b6d-644d-7701-8858-9da6837aaaab';
    const secondFile = path.join(root, 'rollout-' + secondId + '.jsonl');
    await writeLines(firstFile, [sessionMeta(), event('task_started', 'turn-first')]);
    await writeLines(secondFile, [sessionMeta(secondId), event('task_started', 'turn-second')]);
    const reader = new CodexRolloutReader(root);
    const firstCutoff = await reader.captureRolloutEndOffset(firstFile);
    const secondCutoff = await reader.captureRolloutEndOffset(secondFile);
    expect(firstCutoff).toBeDefined();
    expect(secondCutoff).toBeDefined();
    await appendFile(firstFile, event('task_started', 'turn-after-cutoff') + '\n');
    await appendFile(secondFile, event('task_started', 'turn-after-cutoff-2') + '\n');
    const sources = [sourceFor(firstFile), sourceFor(secondFile, secondId)];
    const frozenCutoffs = {
      [cursorKeyForPath(root, firstFile)]: firstCutoff!,
      [cursorKeyForPath(root, secondFile)]: secondCutoff!,
    };
    const baseline = await reader.read(sources, {}, { frozenCutoffs, firstInstallBaseline: true });
    expect(eventTypes(baseline.events)).toEqual(['turn-started', 'turn-started']);
    expect(baseline.events.every(({ baseline: historical }) => historical)).toBe(true);
    expect(baseline.exhaustedSourceIds).toEqual(Object.keys(frozenCutoffs));
    expect(baseline.complete).toBe(true);
    expect(baseline.cursors[cursorKeyForPath(root, firstFile)].offset).toBe(firstCutoff);
    expect(baseline.cursors[cursorKeyForPath(root, secondFile)].offset).toBe(secondCutoff);

    const live = await reader.read(sources, baseline.cursors);
    expect(eventTypes(live.events)).toEqual(['turn-started', 'turn-started']);
    expect(live.events.every(({ baseline: historical }) => !historical)).toBe(true);
  });

  it('reports fixed-boundary exhaustion for an unterminated line and completes it live later', async () => {
    const root = await testRoot();
    const file = path.join(root, 'rollout-' + SESSION_ID + '.jsonl');
    const prefix = sessionMeta() + '\n';
    const partial = event('task_started', 'turn-partial-boundary');
    const split = Math.floor(partial.length / 2);
    await writeFile(file, prefix + partial.slice(0, split));
    const reader = new CodexRolloutReader(root);
    const cutoff = await reader.captureRolloutEndOffset(file);
    expect(cutoff).toBe(prefix.length + split);
    const key = cursorKeyForPath(root, file);
    const first = await reader.read(
      [sourceFor(file)],
      {},
      {
        frozenCutoffs: { [key]: cutoff! },
        firstInstallBaseline: true,
      },
    );
    expect(first.events).toEqual([]);
    expect(first.exhaustedSourceIds).toEqual([key]);
    expect(first.complete).toBe(true);
    expect(first.cursors[key].offset).toBe(prefix.length);
    await appendFile(file, partial.slice(split) + '\n');
    const second = await reader.read([sourceFor(file)], first.cursors);
    expect(eventTypes(second.events)).toEqual(['turn-started']);
    expect(second.events[0]?.baseline).toBe(false);
  });

  it('continues a fixed cutoff through event budget without consuming appends', async () => {
    const root = await testRoot();
    const file = path.join(root, 'rollout-' + SESSION_ID + '.jsonl');
    await writeLines(file, [
      sessionMeta(),
      ...Array.from({ length: MAX_EVENTS_PER_READ + 1 }, (_, index) =>
        event('agent_message', 'turn-fixed-budget', { sequence: index }),
      ),
    ]);
    const reader = new CodexRolloutReader(root);
    const cutoff = await reader.captureRolloutEndOffset(file);
    const key = cursorKeyForPath(root, file);
    const source = sourceFor(file);
    const first = await reader.read(
      [source],
      {},
      {
        frozenCutoffs: { [key]: cutoff! },
        firstInstallBaseline: true,
      },
    );
    expect(first.events).toHaveLength(MAX_EVENTS_PER_READ);
    expect(first.nextSourceIndex).toBe(0);
    expect(first.exhaustedSourceIds).toEqual([]);
    await appendFile(file, event('agent_message', 'turn-live-after-fixed') + '\n');
    const second = await reader.read([source], first.cursors, {
      frozenCutoffs: { [key]: cutoff! },
    });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.baseline).toBe(true);
    expect(second.exhaustedSourceIds).toEqual([key]);
    expect(second.cursors[key].offset).toBe(cutoff);

    const live = await reader.read([source], second.cursors);
    expect(live.events).toHaveLength(1);
    expect(live.events[0]?.baseline).toBe(false);
    expect(live.events[0]?.event).toMatchObject({ turnId: 'turn-live-after-fixed' });
  });

  it('marks replacement contents historical after cursor identity changes', async () => {
    const root = await testRoot();
    const file = path.join(root, 'rollout-' + SESSION_ID + '.jsonl');
    await writeLines(file, [sessionMeta(), event('task_started', 'turn-before-replace')]);
    const reader = new CodexRolloutReader(root);
    const initial = await reader.read([sourceFor(file)]);
    const replacement = sessionMeta() + '\n' + event('task_started', 'turn-replacement') + '\n';
    const replacementFile = file + '.new';
    await writeFile(replacementFile, replacement);
    await rename(replacementFile, file);
    const replaced = await reader.read([sourceFor(file)], initial.cursors);
    expect(replaced.diagnostics.map(({ code }) => code)).toContain('file-reset');
    expect(replaced.events).toHaveLength(1);
    expect(replaced.events[0]?.event).toMatchObject({ turnId: 'turn-replacement' });
    expect(replaced.events[0]?.baseline).toBe(true);
  });
});

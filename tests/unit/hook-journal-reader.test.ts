import { afterEach, describe, expect, it } from 'vitest';
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
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  HookJournalReader,
  makeHookJournalBaseName,
  type HookJournalTarget,
} from '../../src/main/providers/claude/hook-journal-reader';
import { makeCursorKey, type FileCursorMap } from '../../src/shared/cursor';

const MAX_RECORD_BYTES = 4 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const temporaryDirectories: string[] = [];

function target(nativeSessionId = 'session-1'): HookJournalTarget {
  return {
    provider: 'claude',
    nativeSessionId,
    baseName: makeHookJournalBaseName('claude', nativeSessionId),
  };
}

function activePath(root: string, journalTarget: HookJournalTarget): string {
  return join(root, 'journals', journalTarget.provider, `${journalTarget.baseName}.jsonl`);
}

function archivePath(root: string, journalTarget: HookJournalTarget, index: number): string {
  return join(root, 'journals', journalTarget.provider, `${journalTarget.baseName}.jsonl.${index}`);
}

function record(overrides: Record<string, unknown> = {}, sessionId = 'session-1'): string {
  return `${JSON.stringify({
    schema_version: 1,
    provider: 'claude',
    event_name: 'SessionStart',
    session_id: sessionId,
    timestamp: 1_700_000_000_000,
    ...overrides,
  })}\n`;
}

async function isolatedJournalRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-hook-journal-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'journals', 'claude'), { mode: 0o700, recursive: true });
  return root;
}

function cursorFor(
  journalTarget: HookJournalTarget,
  cursors: FileCursorMap,
): FileCursorMap[string] | undefined {
  return cursors[makeCursorKey(journalTarget.provider, journalTarget.baseName)];
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('HookJournalReader', () => {
  it('replays reduced events and follows an active inode across rotation', async () => {
    const root = await isolatedJournalRoot();
    const journalTarget = target();
    const active = activePath(root, journalTarget);
    const firstLine = record({ event_name: 'UserPromptSubmit', turn_id: 'turn-1' });
    await writeFile(active, firstLine);

    const reader = new HookJournalReader({ appDataPath: root });
    const first = await reader.read([journalTarget]);
    const firstCursor = cursorFor(journalTarget, first.cursors);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      eventName: 'UserPromptSubmit',
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    expect(first.events[0]?.eventIdentity).toContain(':');
    expect(firstCursor?.offset).toBe(Buffer.byteLength(firstLine));

    await rename(active, archivePath(root, journalTarget, 1));
    const secondLine = record({ event_name: 'Stop', turn_id: 'turn-1', stop_hook_active: true });
    await writeFile(active, secondLine);
    const second = await reader.read([journalTarget], first.cursors);

    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({
      eventName: 'Stop',
      stopHookActive: true,
    });
    expect(second.events[0]?.eventIdentity).not.toBe(first.events[0]?.eventIdentity);
    expect(cursorFor(journalTarget, second.cursors)?.offset).toBe(Buffer.byteLength(secondLine));
    expect(second.diagnostics).toEqual([]);
  });

  it('replays only appended complete records after a reader restart', async () => {
    const root = await isolatedJournalRoot();
    const journalTarget = target();
    const active = activePath(root, journalTarget);
    const firstLine = record({ event_name: 'SessionStart' });
    const partialLine = record({
      event_name: 'Notification',
      notification_type: 'idle_prompt',
    }).trimEnd();
    await writeFile(active, `${firstLine}${partialLine.slice(0, -1)}`);

    const firstReader = new HookJournalReader({ appDataPath: root });
    const first = await firstReader.read([journalTarget]);
    expect(first.events).toHaveLength(1);
    expect(cursorFor(journalTarget, first.cursors)?.offset).toBe(Buffer.byteLength(firstLine));

    const restarted = new HookJournalReader({ appDataPath: root });
    const noNewEvents = await restarted.read([journalTarget], first.cursors);
    expect(noNewEvents.events).toEqual([]);
    expect(cursorFor(journalTarget, noNewEvents.cursors)?.offset).toBe(
      Buffer.byteLength(firstLine),
    );

    await appendFile(active, `${partialLine.slice(-1)}\n`);
    const completed = await restarted.read([journalTarget], noNewEvents.cursors);
    expect(completed.events).toHaveLength(1);
    expect(completed.events[0]?.eventName).toBe('Notification');
    expect(completed.events[0]?.notificationType).toBe('idle_prompt');
  });

  it('carries shared cursor watermarks and oversized-line continuation state', async () => {
    const root = await isolatedJournalRoot();
    const journalTarget = target();
    const active = activePath(root, journalTarget);
    const oversizedPartial = JSON.stringify({
      schema_version: 1,
      provider: 'claude',
      event_name: 'Stop',
      session_id: 'session-1',
      timestamp: 2,
      prompt: 'x'.repeat(MAX_RECORD_BYTES),
    });
    await writeFile(active, oversizedPartial);

    const reader = new HookJournalReader({ appDataPath: root });
    const first = await reader.read([journalTarget]);
    const firstCursor = cursorFor(journalTarget, first.cursors);
    expect(first.events).toEqual([]);
    expect(firstCursor).toMatchObject({
      offset: Buffer.byteLength(oversizedPartial),
      isDiscardingOversizedLine: true,
    });

    await appendFile(active, `\n${record({ event_name: 'Stop', stop_hook_active: false })}`);
    const second = await reader.read([journalTarget], first.cursors);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ eventName: 'Stop', stopHookActive: false });
    const secondCursor = cursorFor(journalTarget, second.cursors);
    if (secondCursor === undefined) throw new Error('expected continuation cursor');
    expect(secondCursor.isDiscardingOversizedLine).toBe(false);

    const key = makeCursorKey(journalTarget.provider, journalTarget.baseName);
    const withWatermark: FileCursorMap = {
      ...second.cursors,
      [key]: {
        ...secondCursor,
        baselineUntilOffset: 999,
        isDiscardingOversizedLine: false,
      },
    };
    const third = await reader.read([journalTarget], withWatermark);
    expect(cursorFor(journalTarget, third.cursors)).toMatchObject({
      baselineUntilOffset: 999,
      isDiscardingOversizedLine: false,
    });
    const invalidWatermark: FileCursorMap = {
      ...withWatermark,
      [key]: { ...secondCursor, baselineUntilOffset: -1 },
    };
    await expect(reader.read([journalTarget], invalidWatermark)).rejects.toMatchObject({
      code: 'invalid-cursor',
    });
    const invalidDiscardFlag: FileCursorMap = {
      ...withWatermark,
      [key]: { ...secondCursor, isDiscardingOversizedLine: 'no' as never },
    };
    await expect(reader.read([journalTarget], invalidDiscardFlag)).rejects.toMatchObject({
      code: 'invalid-cursor',
    });
  });

  it('keeps malformed and oversized records out of the event stream', async () => {
    const root = await isolatedJournalRoot();
    const journalTarget = target();
    const active = activePath(root, journalTarget);
    const oversized = JSON.stringify({
      schema_version: 1,
      provider: 'claude',
      event_name: 'Notification',
      session_id: 'session-1',
      timestamp: 1,
      notification_type: 'idle_prompt',
      prompt: 'PRIVATE_PROMPT_SENTINEL'.repeat(400),
    });
    const valid = record({
      event_name: 'Notification',
      notification_type: 'permission_prompt',
      prompt: 'PRIVATE_PROMPT_MUST_NOT_ESCAPE',
      transcript: 'PRIVATE_TRANSCRIPT_MUST_NOT_ESCAPE',
      tool_input: 'PRIVATE_TOOL_INPUT_MUST_NOT_ESCAPE',
    });
    await writeFile(active, `not-json\n${oversized}\n${valid}`);

    const result = await new HookJournalReader({ appDataPath: root }).read([journalTarget]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.notificationType).toBe('permission_prompt');
    expect(JSON.stringify(result.events)).not.toContain('PRIVATE_');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'record-malformed',
      'record-oversized',
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(root);
    expect(MAX_RECORD_BYTES).toBe(4 * 1024);
  });

  it('validates provider/session ownership and preserves no unknown fields', async () => {
    const root = await isolatedJournalRoot();
    const journalTarget = target();
    const active = activePath(root, journalTarget);
    await writeFile(
      active,
      `${record({ provider: 'codex' })}${record({ session_id: 'other-session' })}${record({
        event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_call_id: 'call-1',
        answer: 'PRIVATE_ANSWER_MUST_NOT_ESCAPE',
      })}`,
    );

    const result = await new HookJournalReader({ appDataPath: root }).read([journalTarget]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventName: 'PreToolUse',
      toolName: 'AskUserQuestion',
      toolCallId: 'call-1',
    });
    expect(JSON.stringify(result.events)).not.toContain('PRIVATE_');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'record-malformed',
      'record-malformed',
    ]);
  });

  it('reports retention gaps and cursor truncation without claiming completion', async () => {
    const root = await isolatedJournalRoot();
    const journalTarget = target();
    const active = activePath(root, journalTarget);
    await writeFile(active, record({ event_name: 'SessionStart' }));
    const reader = new HookJournalReader({ appDataPath: root });
    const first = await reader.read([journalTarget]);

    await writeFile(active, '');
    const truncated = await reader.read([journalTarget], first.cursors);
    expect(truncated.events).toEqual([]);
    expect(truncated.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'cursor-truncated',
    );

    await rename(active, join(root, 'lost-journal.jsonl'));
    await writeFile(active, record({ event_name: 'SessionEnd' }));
    const gap = await reader.read([journalTarget], first.cursors);
    expect(gap.events).toHaveLength(1);
    expect(gap.events[0]?.eventName).toBe('SessionEnd');
    expect(gap.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'possible-retention-gap',
    );

    await rm(active, { force: true });
    const noFiles = await reader.read([journalTarget], gap.cursors);
    expect(noFiles.events).toEqual([]);
    expect(noFiles.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'possible-retention-gap',
    );
  });

  it('rejects symlinks and unsafe or unqualified targets', async () => {
    const root = await isolatedJournalRoot();
    const journalTarget = target();
    const outside = join(root, 'outside.jsonl');
    await writeFile(outside, record());
    await symlink(outside, activePath(root, journalTarget));

    const symlinkResult = await new HookJournalReader({ appDataPath: root }).read([journalTarget]);
    expect(symlinkResult.events).toEqual([]);
    expect(symlinkResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'unsafe-source',
    );
    expect(JSON.stringify(symlinkResult.diagnostics)).not.toContain(outside);

    await expect(
      new HookJournalReader({ appDataPath: root }).read([
        { ...journalTarget, baseName: '../outside' },
      ]),
    ).rejects.toMatchObject({ code: 'invalid-options' });
  });

  it('ignores missing archives and does not scan unlisted sessions', async () => {
    const root = await isolatedJournalRoot();
    const journalTarget = target();
    const unlistedTarget = target('unlisted-session');
    await writeFile(activePath(root, journalTarget), record({ event_name: 'SessionStart' }));
    await writeFile(activePath(root, unlistedTarget), record({}, 'unlisted-session'));

    const result = await new HookJournalReader({ appDataPath: root }).read([journalTarget]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.sessionId).toBe('session-1');
    expect(result.diagnostics).toEqual([]);
    expect(await readFile(archivePath(root, journalTarget, 1), 'utf8').catch(() => '')).toBe('');
  });

  it('bounds source size and target count before unbounded work', async () => {
    const root = await isolatedJournalRoot();
    const journalTarget = target();
    await writeFile(activePath(root, journalTarget), Buffer.alloc(MAX_FILE_BYTES + 1, 0x78));

    const oversized = await new HookJournalReader({ appDataPath: root }).read([journalTarget]);
    expect(oversized.events).toEqual([]);
    expect(oversized.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'source-oversized',
    );

    const tooManyTargets = Array.from({ length: 129 }, (_, index) => target(`session-${index}`));
    await expect(
      new HookJournalReader({ appDataPath: root }).read(tooManyTargets),
    ).rejects.toMatchObject({
      code: 'invalid-options',
    });
  });

  it('bounds total bytes, projected records, and diagnostics', async () => {
    const bytesRoot = await isolatedJournalRoot();
    const byteTargets = Array.from({ length: 33 }, (_, index) => target(`bytes-${index}`));
    await Promise.all(
      byteTargets.map((journalTarget) =>
        writeFile(activePath(bytesRoot, journalTarget), Buffer.alloc(MAX_FILE_BYTES, 0x78)),
      ),
    );
    const byteResult = await new HookJournalReader({ appDataPath: bytesRoot }).read(byteTargets);
    expect(byteResult.events).toEqual([]);
    expect(byteResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain('read-limit');

    const recordRoot = await isolatedJournalRoot();
    const recordTarget = target('record-limit');
    const boundedRecords = record({}, 'record-limit').repeat(2048);
    await Promise.all([
      writeFile(archivePath(recordRoot, recordTarget, 3), boundedRecords),
      writeFile(archivePath(recordRoot, recordTarget, 2), boundedRecords),
      writeFile(archivePath(recordRoot, recordTarget, 1), boundedRecords),
      writeFile(activePath(recordRoot, recordTarget), boundedRecords),
    ]);
    const recordResult = await new HookJournalReader({ appDataPath: recordRoot }).read([
      recordTarget,
    ]);
    expect(recordResult.events).toHaveLength(4096);
    expect(recordResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain('read-limit');

    const diagnosticRoot = await isolatedJournalRoot();
    const diagnosticTarget = target('diagnostic-limit');
    await writeFile(activePath(diagnosticRoot, diagnosticTarget), 'not-json\n'.repeat(200));
    const diagnosticResult = await new HookJournalReader({ appDataPath: diagnosticRoot }).read([
      diagnosticTarget,
    ]);
    expect(diagnosticResult.events).toEqual([]);
    expect(diagnosticResult.diagnostics).toHaveLength(128);
    expect(diagnosticResult.diagnostics.at(-1)?.code).toBe('diagnostics-truncated');
  });
});

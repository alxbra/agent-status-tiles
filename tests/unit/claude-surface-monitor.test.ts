import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeCliMonitor,
  ClaudeDesktopMonitor,
  MAX_CLAUDE_RECORDS_PER_READ,
  type ClaudeMonitorOptions,
} from '../../src/main/providers/claude/surface-monitor';
import { makeHookJournalBaseName } from '../../src/main/providers/hooks/hook-journal-reader';
import {
  MAX_RUNTIME_EVENTS_PER_READ,
  createRuntimeCoordinator,
} from '../../src/main/runtime/coordinator';
import type { RuntimeReadRequest } from '../../src/main/runtime/coordinator';
import {
  createInitialMonitoringState,
  saveSessionState,
} from '../../src/main/sessions/persistence';
import { reduceSessionState } from '../../src/main/sessions/reducer';
import { createInitialSessionState } from '../../src/shared/session';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-monitor-'));
  roots.push(root);
  await mkdir(join(root, 'journals', 'claude'), { recursive: true, mode: 0o700 });
  return root;
}

let clock = 1_700_000_000_000;

function record(
  sessionId: string,
  eventName: string,
  overrides: Record<string, unknown> = {},
): string {
  clock += 1;
  return `${JSON.stringify({
    schema_version: 1,
    provider: 'claude',
    event_name: eventName,
    session_id: sessionId,
    timestamp: clock,
    project_name: `${sessionId}-project`,
    host: 'claude-desktop',
    ...overrides,
  })}\n`;
}

function journalPath(root: string, sessionId: string): string {
  return join(root, 'journals', 'claude', `${makeHookJournalBaseName('claude', sessionId)}.jsonl`);
}

function readRequest(
  sources: RuntimeReadRequest['sources'],
  overrides: Partial<RuntimeReadRequest> = {},
): RuntimeReadRequest {
  return { sources, cursors: {}, sessions: {}, frozenCutoffs: {}, baseline: false, ...overrides };
}

describe('claude surface monitor', () => {
  it('discovers only its surface, replays journals, and continues from cursors', async () => {
    const root = await appData();
    await writeFile(
      journalPath(root, 'desk'),
      record('desk', 'SessionStart') + record('desk', 'UserPromptSubmit'),
    );
    await writeFile(journalPath(root, 'term'), record('term', 'SessionStart', { host: 'warp' }));
    const desktop = new ClaudeDesktopMonitor({ appDataPath: root });
    const cli = new ClaudeCliMonitor({ appDataPath: root });
    await expect(desktop.discover()).rejects.toThrow('claude-desktop-not-started');
    desktop.start();
    cli.start();

    const discovery = await desktop.discover();
    expect(discovery.complete).toBe(true);
    expect(discovery.sources).toEqual([
      expect.objectContaining({
        id: makeHookJournalBaseName('claude', 'desk'),
        nativeSessionId: 'desk',
        title: 'desk-project',
        isTopLevel: true,
        isArchived: false,
        canOpen: false,
      }),
    ]);
    expect((await cli.discover()).sources.map((source) => source.nativeSessionId)).toEqual([
      'term',
    ]);
    const captured = desktop.capture(discovery.sources);
    expect(captured[0]!.endOffset).toBeGreaterThan(0);

    const first = await desktop.read(readRequest(captured, { baseline: true }));
    expect(first.complete).toBe(true);
    expect(first.exhaustedSourceIds).toEqual([captured[0]!.id]);
    expect(first.events).toEqual([
      { event: expect.objectContaining({ type: 'turn-started' }), historical: true },
    ]);
    expect(Object.keys(first.cursors)).toEqual([captured[0]!.id]);

    // The coordinator hands the reduced record back so the open turn continues.
    let state = reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'claude',
      nativeSessionId: 'desk',
      surface: 'desktop',
      title: 'desk-project',
      isTopLevel: true,
      isArchived: false,
      canOpen: false,
      updatedAt: 1,
    });
    for (const entry of first.events) {
      state = reduceSessionState(state, 'event' in entry ? entry.event : entry);
    }
    await appendFile(journalPath(root, 'desk'), record('desk', 'Stop'));
    const second = await desktop.read(
      readRequest(captured, { cursors: first.cursors, sessions: state.sessions }),
    );
    expect(second.events).toEqual([
      { event: expect.objectContaining({ type: 'turn-completed' }), historical: false },
    ]);
    expect(JSON.stringify([discovery, first, second])).not.toContain(root);

    desktop.stop();
    await expect(desktop.discover()).rejects.toThrow('not-started');
  });

  it('drops an ended session from the cohort and marks malformed journals coverage-incomplete', async () => {
    const root = await appData();
    await writeFile(journalPath(root, 'live'), record('live', 'SessionStart'));
    await writeFile(
      journalPath(root, 'gone'),
      record('gone', 'SessionStart') + record('gone', 'SessionEnd', { end_reason: 'other' }),
    );
    const monitor = new ClaudeDesktopMonitor({ appDataPath: root });
    monitor.start();
    const discovery = await monitor.discover();
    expect(discovery.sources.map((source) => source.nativeSessionId)).toEqual(['live']);

    // A source whose journal disappears before the read is reported unavailable, not fatal.
    const sources = monitor.capture(discovery.sources);
    await rm(journalPath(root, 'live'));
    await writeFile(join(root, 'journals', 'claude', `${sources[0]!.id}.jsonl`), 'not json\n');
    const read = await monitor.read(readRequest(sources));
    expect(read.coverageIncomplete).toBe(true);
    expect(read.unavailableSourceIds).toBeUndefined();
    expect(read.events).toEqual([]);
    await expect(
      monitor.read(readRequest([{ ...sources[0]!, nativeSessionId: 'other' }])),
    ).rejects.toThrow('source-changed');
  });

  it('runs through the coordinator: baseline lands idle, live events publish, ended sessions prune', async () => {
    const root = await appData();
    await writeFile(
      journalPath(root, 'desk'),
      record('desk', 'SessionStart') + record('desk', 'UserPromptSubmit') + record('desk', 'Stop'),
    );
    const monitoring = createInitialMonitoringState();
    monitoring.partitions['claude:desktop'].enabled = true;
    await saveSessionState(root, monitoring);
    const runtime = createRuntimeCoordinator({
      appDataPath: root,
      monitors: [new ClaudeDesktopMonitor({ appDataPath: root })],
      catalogPollIntervalMs: 20,
      filePollIntervalMs: 10,
    });
    try {
      await runtime.start();
      await expect
        .poll(() => runtime.getMonitoringState().partitions['claude:desktop'].baseline.status)
        .toBe('ready');
      // Historical completion never turns green on first observation.
      expect(runtime.getOverlayState().sessions).toEqual([
        expect.objectContaining({ id: 'claude:desk', status: 'idle', title: 'desk-project' }),
      ]);
      expect(runtime.getHealth()['claude:desktop'].status).toBe('available');

      await appendFile(journalPath(root, 'desk'), record('desk', 'UserPromptSubmit'));
      await expect.poll(() => runtime.getOverlayState().sessions[0]?.status).toBe('working');
      await appendFile(
        journalPath(root, 'desk'),
        record('desk', 'PermissionRequest', { tool_call_id: 'call-1' }),
      );
      await expect.poll(() => runtime.getOverlayState().sessions[0]?.status).toBe('needs-input');
      await appendFile(
        journalPath(root, 'desk'),
        record('desk', 'PostToolUse', { tool_call_id: 'call-1' }) + record('desk', 'Stop'),
      );
      await expect.poll(() => runtime.getOverlayState().sessions[0]?.status).toBe('unread');

      await appendFile(
        journalPath(root, 'desk'),
        record('desk', 'SessionEnd', { end_reason: 'other' }),
      );
      await expect.poll(() => runtime.getOverlayState().sessions).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  it('reports a journal replaced by a directory as unavailable without failing the read', async () => {
    const root = await appData();
    await writeFile(journalPath(root, 'gone'), record('gone', 'SessionStart'));
    const monitor = new ClaudeDesktopMonitor({ appDataPath: root });
    monitor.start();
    const sources = monitor.capture((await monitor.discover()).sources);
    await rm(journalPath(root, 'gone'));
    await mkdir(journalPath(root, 'gone'));
    const read = await monitor.read(readRequest(sources));
    expect(read.events).toEqual([]);
    expect(read.unavailableSourceIds).toEqual([sources[0]!.id]);
    expect(read.exhaustedSourceIds).toContain(sources[0]!.id);
    expect(read.complete).toBe(true);
  });

  it('replays at most ten sources and keeps the rest metadata-only', async () => {
    const summaries = Array.from({ length: 12 }, (_, index) => ({
      baseName: `b${index}`,
      nativeSessionId: `s${index}`,
      surface: 'desktop' as const,
      ended: false,
      updatedAt: 100 - index,
      endOffset: 1,
    }));
    const targetsSeen: number[] = [];
    const monitor = new ClaudeDesktopMonitor({
      appDataPath: '/unused',
      discovery: { list: async () => summaries, truncated: false },
      reader: {
        read: async (targets) => {
          targetsSeen.push(targets.length);
          return { events: [], cursors: {}, diagnostics: [] };
        },
      },
    });
    monitor.start();
    const sources = monitor.capture((await monitor.discover()).sources);
    expect(sources).toHaveLength(12);
    const read = await monitor.read(readRequest(sources));
    expect(targetsSeen).toEqual([10]);
    expect(read.unavailableSourceIds).toEqual(['b10', 'b11']);
    expect(read.exhaustedSourceIds).toEqual([...sources.map((source) => source.id)]);
  });

  it('pages long journals so one read never exceeds the coordinator event cap', async () => {
    const root = await appData();
    // Lean records keep the journal under the reader's 256 KiB file bound
    // while still exceeding the per-read record page. Each turn stays under
    // the per-turn request bound, and the leading activity record shifts the
    // page boundary onto a request so the next page starts by resolving it.
    const lean = { project_name: undefined, host: undefined };
    const turns = 8;
    const pairsPerTurn = 100;
    let content = record('busy', 'SessionStart') + record('busy', 'PreToolUse', lean);
    for (let turn = 0; turn < turns; turn += 1) {
      content += record('busy', 'UserPromptSubmit', lean);
      for (let index = 0; index < pairsPerTurn; index += 1) {
        content +=
          record('busy', 'PermissionRequest', { ...lean, tool_call_id: `call-${turn}-${index}` }) +
          record('busy', 'PostToolUse', { ...lean, tool_call_id: `call-${turn}-${index}` });
      }
      content += record('busy', 'Stop', lean);
    }
    const records = 2 + turns * (2 + pairsPerTurn * 2);
    expect(Buffer.byteLength(content)).toBeLessThan(256 * 1024);
    expect(records).toBeGreaterThan(MAX_CLAUDE_RECORDS_PER_READ);
    await writeFile(journalPath(root, 'busy'), content);
    const monitor = new ClaudeDesktopMonitor({ appDataPath: root });
    monitor.start();
    const sources = monitor.capture((await monitor.discover()).sources);

    const first = await monitor.read(readRequest(sources));
    expect(first.events.length).toBeLessThanOrEqual(MAX_RUNTIME_EVENTS_PER_READ);
    expect(first.events.length).toBeGreaterThan(MAX_CLAUDE_RECORDS_PER_READ);
    expect(first.events.at(-1)).toEqual({
      event: expect.objectContaining({ type: 'input-requested' }),
      historical: false,
    });
    expect(first.complete).toBe(false);
    expect(first.nextSourceIndex).toBe(0);
    expect(first.exhaustedSourceIds).toEqual([]);
    expect(first.coverageIncomplete).toBeUndefined();

    // The coordinator hands the reduced record back between pages so the open
    // turn and its request continue across the boundary.
    let state = reduceSessionState(createInitialSessionState(), {
      type: 'upsert',
      provider: 'claude',
      nativeSessionId: 'busy',
      surface: 'desktop',
      title: 'busy-project',
      isTopLevel: true,
      isArchived: false,
      canOpen: false,
      updatedAt: 1,
    });
    const reduceAll = (entries: typeof first.events): void => {
      for (const entry of entries) {
        state = reduceSessionState(state, 'event' in entry ? entry.event : entry);
      }
    };
    reduceAll(first.events);
    let cursors = first.cursors;
    let total = first.events.length;
    let passes = 1;
    let result = first;
    while (!result.complete) {
      if (passes > 8) throw new Error('paging did not converge');
      const openTurn = state.sessions['claude:busy']!.activeTurnId;
      result = await monitor.read(
        readRequest(sources, {
          cursors,
          sessions: state.sessions,
          sourceStart: result.nextSourceIndex,
        }),
      );
      expect(result.events.length).toBeLessThanOrEqual(MAX_RUNTIME_EVENTS_PER_READ);
      if (passes === 1) {
        expect(result.events[0]).toEqual({
          event: expect.objectContaining({ type: 'input-resolved', turnId: openTurn }),
          historical: false,
        });
      }
      reduceAll(result.events);
      cursors = result.cursors;
      total += result.events.length;
      passes += 1;
    }
    expect(passes).toBeGreaterThan(1);
    expect(result.exhaustedSourceIds).toEqual([sources[0]!.id]);
    // One activity before any turn; per turn a start, three events per pair, and a completion.
    expect(total).toBe(1 + turns * (2 + pairsPerTurn * 3));
    expect(state.sessions['claude:busy']!.status).toBe('unread');
  });

  it('keeps only turn events during a baseline and survives a turn with many prompts', async () => {
    const root = await appData();
    let content = record('many', 'SessionStart') + record('many', 'UserPromptSubmit');
    for (let index = 0; index < 70; index += 1) {
      content +=
        record('many', 'PermissionRequest', { tool_call_id: `p-${index}` }) +
        record('many', 'Notification', { notification_type: 'permission_prompt' }) +
        record('many', 'PostToolUse', { tool_call_id: `p-${index}` });
    }
    content += record('many', 'PermissionRequest', { tool_call_id: 'open' });
    await writeFile(journalPath(root, 'many'), content);
    const monitoring = createInitialMonitoringState();
    monitoring.partitions['claude:desktop'].enabled = true;
    await saveSessionState(root, monitoring);
    const runtime = createRuntimeCoordinator({
      appDataPath: root,
      monitors: [new ClaudeDesktopMonitor({ appDataPath: root })],
      catalogPollIntervalMs: 20,
      filePollIntervalMs: 10,
    });
    try {
      await runtime.start();
      await expect
        .poll(() => runtime.getMonitoringState().partitions['claude:desktop'].baseline.status)
        .toBe('ready');
      expect(runtime.getHealth()['claude:desktop'].status).toBe('available');
      // The wait open at connect time shows as working until its next record.
      expect(runtime.getOverlayState().sessions).toEqual([
        expect.objectContaining({ id: 'claude:many', status: 'working' }),
      ]);
      // Live records after the baseline: another 70 prompts in the same turn
      // stay within the persisted bound and the surface stays healthy.
      let live = '';
      for (let index = 0; index < 70; index += 1) {
        live +=
          record('many', 'PermissionRequest', { tool_call_id: `q-${index}` }) +
          record('many', 'PostToolUse', { tool_call_id: `q-${index}` });
      }
      live += record('many', 'PermissionRequest', { tool_call_id: 'last' });
      await appendFile(journalPath(root, 'many'), live);
      await expect
        .poll(() => runtime.getOverlayState().sessions[0]?.status, { timeout: 5_000 })
        .toBe('needs-input');
      expect(runtime.getHealth()['claude:desktop'].status).toBe('available');
      await appendFile(journalPath(root, 'many'), record('many', 'Stop'));
      await expect.poll(() => runtime.getOverlayState().sessions[0]?.status).toBe('unread');
    } finally {
      await runtime.stop();
    }
  });

  it('refuses to start until the helper and hooks are ready and remembers why', async () => {
    let readiness: Awaited<ReturnType<NonNullable<ClaudeMonitorOptions['checkReadiness']>>> = {
      status: 'issue',
      issue: 'hooks-missing',
    };
    const monitor = new ClaudeCliMonitor({
      appDataPath: '/unused',
      discovery: { list: async () => [], truncated: false },
      reader: { read: async () => ({ events: [], cursors: {}, diagnostics: [] }) },
      checkReadiness: async () => readiness,
    });
    await expect(monitor.start()).rejects.toThrow('claude-cli-hooks-missing');
    expect(monitor.lastIssue).toBe('hooks-missing');
    await expect(monitor.discover()).rejects.toThrow('not-started');

    readiness = { status: 'issue', issue: 'settings-unreadable' };
    await expect(monitor.start()).rejects.toThrow('claude-cli-settings-unreadable');
    expect(monitor.lastIssue).toBe('settings-unreadable');

    readiness = { status: 'ready' };
    await monitor.start();
    expect(monitor.lastIssue).toBeUndefined();
    expect((await monitor.discover()).sources).toEqual([]);

    readiness = { status: 'issue', issue: 'hooks-disabled' };
    await expect(monitor.start()).rejects.toThrow('hooks-disabled');
    monitor.stop();
    expect(monitor.lastIssue).toBeUndefined();
  });
});

describe('claude surface monitor collection', () => {
  it('asks the collector to sweep after each discovery and survives a failing sweep', async () => {
    const root = await appData();
    await writeFile(journalPath(root, 'desk'), record('desk', 'SessionStart'));
    const sweeps: number[] = [];
    let fail = false;
    const monitor = new ClaudeDesktopMonitor({
      appDataPath: root,
      collector: {
        sweep: async () => {
          sweeps.push(Date.now());
          if (fail) throw new Error('disk');
          return undefined;
        },
      },
    });
    monitor.start();
    expect(monitor.cohort).toEqual(new Set());
    expect((await monitor.discover()).sources).toHaveLength(1);
    expect(monitor.cohort).toEqual(new Set([makeHookJournalBaseName('claude', 'desk')]));
    fail = true;
    expect((await monitor.discover()).sources).toHaveLength(1);
    expect(sweeps).toHaveLength(2);
    monitor.stop();
    expect(monitor.cohort).toEqual(new Set());

    const throwing = new ClaudeDesktopMonitor({
      appDataPath: root,
      collector: {
        sweep: () => {
          throw new Error('sync');
        },
      },
    });
    throwing.start();
    expect((await throwing.discover()).sources).toHaveLength(1);
  });
});

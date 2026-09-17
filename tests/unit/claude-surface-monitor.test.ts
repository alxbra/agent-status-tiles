import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeCliMonitor,
  ClaudeDesktopMonitor,
} from '../../src/main/providers/claude/surface-monitor';
import { makeHookJournalBaseName } from '../../src/main/providers/hooks/hook-journal-reader';
import { createRuntimeCoordinator } from '../../src/main/runtime/coordinator';
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
    expect(JSON.stringify([discovery, first, second])).not.toContain('journals');

    desktop.stop();
    await expect(desktop.discover()).rejects.toThrow('not-started');
  });

  it('drops an ended session from the cohort and marks unreadable journals unavailable', async () => {
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
});

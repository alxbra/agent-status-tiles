import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexCliMonitor } from '../../src/main/providers/codex/cli-monitor';
import type {
  CodexCatalogRecord,
  CodexListThreadsResult,
} from '../../src/main/providers/codex/catalog-client';

const nativeId = '11111111-1111-7111-8111-111111111111';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-cli-monitor-'));
  roots.push(root);
  const sessionsRoot = join(root, 'sessions');
  await mkdir(sessionsRoot);
  const rolloutPath = join(sessionsRoot, 'rollout.jsonl');
  await writeFile(
    rolloutPath,
    `${JSON.stringify({ timestamp: '2026-09-15T10:00:00.000Z', type: 'session_meta', payload: { id: nativeId, source: 'cli', originator: 'codex_cli_rs' } })}\n${JSON.stringify({ timestamp: '2026-09-15T10:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'historical' } })}\n`,
  );
  const cliRecord: CodexCatalogRecord = {
    nativeId: '22222222-2222-7222-8222-222222222222',
    sessionId: nativeId,
    createdAt: 1,
    updatedAt: 2,
    isArchived: false,
    isEphemeral: false,
    projectBasename: 'cli-project',
    rolloutPath,
    sourceEvidence: {
      source: 'cli',
      originator: 'codex_cli_rs',
      cliVersion: 'test',
      isSubAgent: false,
    },
  };
  const desktopRecord: CodexCatalogRecord = {
    ...cliRecord,
    nativeId: '33333333-3333-7333-8333-333333333333',
    sourceEvidence: { ...cliRecord.sourceEvidence, source: 'vscode', originator: 'Codex Desktop' },
  };
  const catalog = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    listThreads: vi.fn(async (): Promise<CodexListThreadsResult> => ({
      records: [desktopRecord, cliRecord],
      nextCursor: null,
      pagesRead: 1,
      complete: true,
    })),
  };
  return { monitor: new CodexCliMonitor({ sessionsRoot, catalog }), catalog, rolloutPath };
}

describe('Codex CLI monitor', () => {
  it('ignores Desktop records and replays CLI history to a fixed cutoff', async () => {
    const { monitor, catalog, rolloutPath } = await fixture();
    try {
      await monitor.start();
      expect(monitor.key).toBe('codex:cli');
      const discovery = await monitor.discover();
      expect(catalog.listThreads).toHaveBeenCalledWith({ pageSize: 25, maxPages: 1 });
      expect(discovery.sources).toMatchObject([
        {
          nativeSessionId: '22222222-2222-7222-8222-222222222222',
          legacySessionId: nativeId,
          title: 'cli-project',
          canOpen: false,
        },
      ]);
      const captured = await monitor.capture(discovery.sources);
      await appendFile(
        rolloutPath,
        `${JSON.stringify({ timestamp: '2026-09-15T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'historical', last_agent_message: 'PRIVATE' } })}\n`,
      );
      const baseline = await monitor.read({
        sources: captured,
        cursors: {},
        sessions: {},
        frozenCutoffs: { [captured[0].id]: captured[0].endOffset! },
        baseline: true,
      });
      expect(baseline.events).toMatchObject([
        { event: { type: 'turn-started' }, historical: true },
      ]);
      expect(JSON.stringify(baseline)).not.toContain('PRIVATE');
      const live = await monitor.read({
        sources: captured,
        cursors: baseline.cursors,
        sessions: {},
        frozenCutoffs: {},
        baseline: false,
      });
      expect(live.events).toMatchObject([{ event: { type: 'turn-completed' }, historical: false }]);
    } finally {
      await monitor.stop();
    }
  });
});

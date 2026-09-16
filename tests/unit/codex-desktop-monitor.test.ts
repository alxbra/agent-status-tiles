import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexDesktopMonitor } from '../../src/main/providers/codex/desktop-monitor';
import type {
  CodexCatalogRecord,
  CodexListThreadsResult,
} from '../../src/main/providers/codex/catalog-client';
import { createInitialSessionState } from '../../src/shared/session';
import { reduceSessionState } from '../../src/main/sessions/reducer';

const nativeId = '11111111-1111-7111-8111-111111111111';
const catalogId = '22222222-2222-7222-8222-222222222222';
const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-desktop-monitor-'));
  directories.push(root);
  const sessionsRoot = join(root, 'sessions');
  await mkdir(sessionsRoot);
  const rolloutPath = join(sessionsRoot, 'rollout.jsonl');
  const meta = JSON.stringify({
    timestamp: '2026-09-15T10:00:00.000Z',
    type: 'session_meta',
    payload: { id: nativeId, source: 'vscode', originator: 'Codex Desktop' },
  });
  const started = JSON.stringify({
    timestamp: '2026-09-15T10:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1' },
  });
  await writeFile(rolloutPath, `${meta}\n${started}\n`);
  const record: CodexCatalogRecord = {
    nativeId: catalogId,
    sessionId: nativeId,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    isArchived: false,
    isEphemeral: false,
    projectBasename: 'example-project',
    rolloutPath,
    sourceEvidence: {
      source: 'vscode',
      originator: 'Codex Desktop',
      cliVersion: 'test',
      isSubAgent: false,
    },
  };
  const catalog = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    listThreads: vi.fn(async (): Promise<CodexListThreadsResult> => ({
      records: [record],
      nextCursor: null,
      pagesRead: 2,
      complete: true,
    })),
  };
  const monitor = new CodexDesktopMonitor({ sessionsRoot, catalog });
  return { monitor, catalog, record, rolloutPath };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Codex Desktop monitor', () => {
  it('resolves a catalog ID difference from rollout metadata and replays only the fixed baseline', async () => {
    const { monitor, catalog, rolloutPath } = await fixture();
    try {
      await monitor.start();
      const discovered = await monitor.discover();
      expect(catalog.listThreads).toHaveBeenCalledWith(
        expect.objectContaining({ includeArchived: true }),
      );
      expect(discovered.sources).toMatchObject([
        { nativeSessionId: nativeId, title: 'example-project', canOpen: false },
      ]);
      const sources = await monitor.capture(discovered.sources);
      const source = sources[0];
      expect(source.endOffset).toBeGreaterThan(0);
      await appendFile(
        rolloutPath,
        `${JSON.stringify({
          timestamp: '2026-09-15T10:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'PRIVATE' },
        })}\n`,
      );
      const baseline = await monitor.read({
        sources,
        cursors: {},
        sessions: {},
        frozenCutoffs: { [source.id]: source.endOffset! },
        baseline: true,
      });
      expect(baseline.complete).toBe(true);
      expect(baseline.events).toMatchObject([
        { event: { type: 'turn-started' }, historical: true },
      ]);
      expect(JSON.stringify(baseline)).not.toContain('PRIVATE');
      let state = reduceSessionState(createInitialSessionState(), {
        type: 'upsert',
        provider: 'codex',
        surface: 'desktop',
        nativeSessionId: nativeId,
        title: 'example-project',
        isTopLevel: true,
        isArchived: false,
        canOpen: false,
        updatedAt: source.updatedAt,
      });
      for (const entry of baseline.events) {
        state = reduceSessionState(state, 'event' in entry ? entry.event : entry);
      }
      const live = await monitor.read({
        sources,
        cursors: baseline.cursors,
        sessions: state.sessions,
        frozenCutoffs: {},
        baseline: false,
      });
      expect(live.events).toMatchObject([{ event: { type: 'turn-completed' }, historical: false }]);
    } finally {
      await monitor.stop();
    }
  });

  it('fails closed on an incomplete catalog or unmatched rollout identity', async () => {
    const { monitor, catalog, record } = await fixture();
    try {
      await monitor.start();
      catalog.listThreads.mockResolvedValueOnce({
        records: [record],
        nextCursor: null,
        pagesRead: 16,
        complete: false,
      });
      await expect(monitor.discover()).rejects.toThrow('desktop-catalog-incomplete');
      catalog.listThreads.mockResolvedValueOnce({
        records: [{ ...record, nativeId: catalogId, sessionId: catalogId }],
        nextCursor: null,
        pagesRead: 1,
        complete: true,
      });
      await expect(monitor.discover()).rejects.toThrow('desktop-rollout-identity-mismatch');
    } finally {
      await monitor.stop();
    }
  });

  it('follows catalog continuation before declaring Desktop coverage complete', async () => {
    const { monitor, catalog, record } = await fixture();
    catalog.listThreads
      .mockResolvedValueOnce({
        records: [],
        nextCursor: 'next-page',
        pagesRead: 16,
        complete: false,
      })
      .mockResolvedValueOnce({
        records: [record],
        nextCursor: null,
        pagesRead: 1,
        complete: true,
      });
    try {
      await monitor.start();
      const discovery = await monitor.discover();
      expect(discovery.sources).toHaveLength(1);
      expect(catalog.listThreads).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'next-page', includeArchived: true }),
      );
    } finally {
      await monitor.stop();
    }
  });

  it('replays a replaced rollout historically and advances its safe cursor', async () => {
    const { monitor, rolloutPath } = await fixture();
    try {
      await monitor.start();
      const sources = await monitor.capture((await monitor.discover()).sources);
      const source = sources[0];
      const baseline = await monitor.read({
        sources,
        cursors: {},
        sessions: {},
        frozenCutoffs: { [source.id]: source.endOffset! },
        baseline: true,
      });
      await rename(rolloutPath, `${rolloutPath}.old`);
      await writeFile(
        rolloutPath,
        `${JSON.stringify({ timestamp: '2026-09-15T10:00:00.000Z', type: 'session_meta', payload: { id: nativeId } })}\n${JSON.stringify(
          {
            timestamp: '2026-09-15T10:00:03.000Z',
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'replacement' },
          },
        )}\n${JSON.stringify({
          timestamp: '2026-09-15T10:00:04.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'replacement' },
        })}\n`,
      );
      const replacement = await monitor.read({
        sources,
        cursors: baseline.cursors,
        sessions: {},
        frozenCutoffs: {},
        baseline: false,
      });
      expect(replacement.complete).toBe(true);
      expect(replacement.events).toMatchObject([
        { event: { type: 'turn-started' }, historical: true },
        { event: { type: 'turn-completed' }, historical: true },
      ]);
      expect(replacement.cursors[source.id]?.identity).not.toBe(
        baseline.cursors[source.id]?.identity,
      );
    } finally {
      await monitor.stop();
    }
  });
});

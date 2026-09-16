import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexDesktopMonitor } from '../../src/main/providers/codex/desktop-monitor';
import type { CodexCatalogRecord } from '../../src/main/providers/codex/catalog-client';
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
    listThreads: vi.fn(async () => ({
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
      expect(catalog.listThreads).toHaveBeenCalledWith({ includeArchived: true });
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
});

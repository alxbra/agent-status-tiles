import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const archivedSessionsRoot = join(root, 'archived_sessions');
  await mkdir(sessionsRoot);
  await mkdir(archivedSessionsRoot);
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
  const monitor = new CodexDesktopMonitor({ sessionsRoot, archivedSessionsRoot, catalog });
  return { monitor, catalog, record, rolloutPath, archivedSessionsRoot };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Codex Desktop monitor', () => {
  it('uses validated rollout originator when the catalog omits it', async () => {
    const { monitor, catalog, record, rolloutPath } = await fixture();
    catalog.listThreads.mockResolvedValue({
      records: [{ ...record, sourceEvidence: { ...record.sourceEvidence, originator: undefined } }],
      nextCursor: null,
      pagesRead: 1,
      complete: true,
    });
    try {
      await monitor.start();
      const confirmed = await monitor.discover();
      expect(confirmed.sources.map((source) => source.nativeSessionId)).toEqual([catalogId]);
      expect(confirmed.coverageIncomplete).toBeUndefined();

      for (const [source, originator] of [
        ['vscode', 'Other Editor'],
        ['vscode', undefined],
        ['cli', 'Codex Desktop'],
      ] as const) {
        await writeFile(
          rolloutPath,
          `${JSON.stringify({ type: 'session_meta', payload: { id: nativeId, source, originator } })}\n`,
        );
        const rejected = await monitor.discover();
        expect(rejected.sources).toEqual([]);
        expect(rejected.coverageIncomplete).toBe(true);
      }
    } finally {
      await monitor.stop();
    }
  });

  it('keeps distinct thread IDs with one rollout session ID separate and rejects a shared rollout file', async () => {
    const { monitor, catalog, record, rolloutPath } = await fixture();
    const secondId = '44444444-4444-7444-8444-444444444444';
    const secondPath = join(dirname(rolloutPath), 'second.jsonl');
    await writeFile(
      secondPath,
      `${JSON.stringify({ timestamp: '2026-09-15T10:00:00.000Z', type: 'session_meta', payload: { id: nativeId } })}\n${JSON.stringify({ timestamp: '2026-09-15T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } })}\n`,
    );
    catalog.listThreads.mockResolvedValue({
      records: [
        record,
        { ...record, nativeId: secondId, rolloutPath: secondPath, name: 'Second task' },
      ],
      nextCursor: null,
      pagesRead: 1,
      complete: true,
    });
    try {
      await monitor.start();
      const discovery = await monitor.discover();
      expect(discovery.sources.map((source) => source.nativeSessionId)).toEqual([
        catalogId,
        secondId,
      ]);
      expect(discovery.sources[1].title).toBe('Second task');
      const captured = await monitor.capture(discovery.sources);
      const read = await monitor.read({
        sources: captured,
        cursors: {},
        sessions: {},
        frozenCutoffs: {},
        baseline: false,
      });
      expect(
        read.events.map((entry) => {
          const event = 'event' in entry ? entry.event : entry;
          return 'sessionId' in event ? event.sessionId : undefined;
        }),
      ).toEqual([`codex:${catalogId}`, `codex:${secondId}`]);
      catalog.listThreads.mockResolvedValue({
        records: [record, { ...record, nativeId: secondId }],
        nextCursor: null,
        pagesRead: 1,
        complete: true,
      });
      const ambiguous = await monitor.discover();
      expect(ambiguous.sources).toEqual([]);
      expect(ambiguous.coverageIncomplete).toBe(true);
    } finally {
      await monitor.stop();
    }
  });

  it('resolves a catalog ID difference from rollout metadata and replays only the fixed baseline', async () => {
    const { monitor, catalog, rolloutPath } = await fixture();
    try {
      await monitor.start();
      const discovered = await monitor.discover();
      expect(catalog.listThreads).toHaveBeenCalledWith(
        expect.objectContaining({ includeArchived: true }),
      );
      expect(discovered.sources).toMatchObject([
        {
          nativeSessionId: catalogId,
          legacySessionId: nativeId,
          title: 'example-project',
          canOpen: false,
        },
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
        nativeSessionId: source.nativeSessionId,
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

  it('fails closed on an incomplete catalog and quarantines unmatched rollout identity', async () => {
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
      const unmatched = await monitor.discover();
      expect(unmatched.coverageIncomplete).toBe(true);
      expect(unmatched.sources).toEqual([]);
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

  it('keeps confirmed Desktop sources while reporting ambiguous legacy coverage', async () => {
    const { monitor, catalog, record } = await fixture();
    catalog.listThreads.mockResolvedValue({
      records: [
        record,
        {
          ...record,
          nativeId: '33333333-3333-7333-8333-333333333333',
          sessionId: '33333333-3333-7333-8333-333333333333',
          sourceEvidence: { ...record.sourceEvidence, source: 'unknown', originator: undefined },
        },
      ],
      nextCursor: null,
      pagesRead: 1,
      complete: true,
      coverageIncomplete: true,
    });
    try {
      await monitor.start();
      const discovered = await monitor.discover();
      expect(discovered.complete).toBe(true);
      expect(discovered.coverageIncomplete).toBe(true);
      expect(discovered.sources).toMatchObject([{ nativeSessionId: record.nativeId }]);
    } finally {
      await monitor.stop();
    }
  });

  it('marks archived catalog sessions without replaying files outside the active root', async () => {
    const { monitor, catalog, record, archivedSessionsRoot } = await fixture();
    const archivedId = '44444444-4444-7444-8444-444444444444';
    const archivedPath = join(archivedSessionsRoot, 'archived.jsonl');
    await writeFile(
      archivedPath,
      `${JSON.stringify({ timestamp: '2026-09-15T10:00:00.000Z', type: 'session_meta', payload: { id: archivedId } })}\n`,
    );
    catalog.listThreads.mockResolvedValue({
      records: [
        record,
        {
          ...record,
          nativeId: archivedId,
          sessionId: archivedId,
          rolloutPath: archivedPath,
          isArchived: true,
        },
      ],
      nextCursor: null,
      pagesRead: 2,
      complete: true,
    });
    try {
      await monitor.start();
      const sources = (await monitor.discover()).sources;
      expect(sources.map((source) => source.isArchived)).toEqual([false, true]);
      const captured = await monitor.capture(sources);
      expect(captured[1].endOffset).toBe(0);
      const result = await monitor.read({
        sources: captured,
        cursors: {},
        sessions: {},
        frozenCutoffs: Object.fromEntries(captured.map((source) => [source.id, source.endOffset!])),
        baseline: true,
      });
      expect(result.events).toMatchObject([{ event: { type: 'turn-started' } }]);
      expect(result.exhaustedSourceIds).toContain(captured[1].id);
      expect(result.cursors[captured[1].id]).toBeUndefined();
    } finally {
      await monitor.stop();
    }
  });

  it('keeps confirmed events when an unrelated rollout item cannot be interpreted', async () => {
    const { monitor, rolloutPath } = await fixture();
    await appendFile(
      rolloutPath,
      `${JSON.stringify({
        timestamp: '2026-09-15T10:00:02.000Z',
        type: 'unknown_item',
        payload: { text: 'PRIVATE' },
      })}\n`,
    );
    try {
      await monitor.start();
      const sources = await monitor.capture((await monitor.discover()).sources);
      const result = await monitor.read({
        sources,
        cursors: {},
        sessions: {},
        frozenCutoffs: { [sources[0].id]: sources[0].endOffset! },
        baseline: true,
      });
      expect(result.complete).toBe(true);
      expect(result.coverageIncomplete).toBe(true);
      expect(result.events).toMatchObject([{ event: { type: 'turn-started' } }]);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
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

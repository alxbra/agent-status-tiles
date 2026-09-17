import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeSessionId, type SessionRecord, type Surface } from '../../../shared/session';
import { MAX_RECENT_THREAD_LIMIT, RECENT_THREAD_DISCOVERY_WINDOW } from '../../../shared/settings';
import type {
  ProviderSurfaceMonitor,
  RuntimeDiscoveryResult,
  RuntimeMonitorSource,
  RuntimeReadRequest,
  RuntimeReadResult,
} from '../../runtime/coordinator';
import { resolveBundledCodexBinary } from './bundled-binary-resolver';
import { CodexCatalogClient, type CodexCatalogRecord } from './catalog-client';
import { qualifyCodexDesktopCatalog } from './catalog-qualification';
import { CodexRolloutReader, cursorKeyForPath, hashPath } from './rollout-reader';
import type { CodexRolloutSource } from './events';

type Catalog = Pick<CodexCatalogClient, 'start' | 'stop' | 'listThreads'>;
type Reader = Pick<
  CodexRolloutReader,
  'start' | 'stop' | 'inspectSessionMeta' | 'captureRolloutEndOffset' | 'read'
>;

export interface CodexMonitorOptions {
  /** Test injection; production uses the configured surface's validated resolver. */
  catalog?: Catalog;
  reader?: Reader;
  sessionsRoot?: string;
  archivedSessionsRoot?: string;
  resolveBinary?: () => Promise<BinaryResolution>;
}

export type CodexDesktopMonitorOptions = CodexMonitorOptions;

type BinaryResolution = { ok: true; binaryPath: string } | { ok: false; code: string };

export interface QualifiedCodexCatalog {
  sessions: readonly {
    nativeId: string;
    sessionId: string;
    projectBasename: string;
    name?: string;
    rolloutPath?: string;
    updatedAt: number;
    isArchived: boolean;
  }[];
  needsRolloutProof?: QualifiedCodexCatalog['sessions'];
  issues: readonly unknown[];
}

interface DiscoveredFile {
  path: string;
  nativeSessionId: string;
  rolloutSessionId: string;
  isArchived: boolean;
}

// Discovery reads one live `thread/list` page of the shared discovery window.
// The app-server rescans its session store on every call and its cost is per
// call, not per record, so one page is far cheaper than several narrow ones; a
// narrower server-side sourceKinds filter measured ~3x the per-call cost and is
// deliberately not used. The page is dominated by discarded preview text, so
// the catalog client's protocol-line bound sizes it, not the record count.
const NONFATAL_COVERAGE_DIAGNOSTICS = new Set([
  'missing-call-id',
  'unsupported-item',
  'unsupported-event',
]);

function runtimeSourceId(cursorKey: string): string {
  if (!cursorKey.startsWith('codex:')) throw new Error('invalid-codex-cursor-key');
  return cursorKey.slice('codex:'.length);
}

function readerCursorKey(sourceId: string): string {
  return `codex:${sourceId}`;
}

/** The only path-bearing state is transient and confined to the main process. */
export class CodexSurfaceMonitor implements ProviderSurfaceMonitor {
  readonly key: 'codex:desktop' | 'codex:cli';
  private readonly sessionsRoot: string;
  private readonly archivedSessionsRoot: string;
  private readonly reader: Reader;
  private readonly archivedReader: CodexRolloutReader;
  private readonly resolveBinary: () => Promise<BinaryResolution>;
  private catalog: Catalog | undefined;
  private files = new Map<string, DiscoveredFile>();
  /** Unreadable files are retried after the monitor restarts, not on every poll. */
  private unreadablePaths = new Set<string>();
  private unavailableSourceIds = new Set<string>();
  private started = false;

  constructor(
    private readonly options: CodexMonitorOptions,
    private readonly surface: Extract<Surface, 'desktop' | 'cli'>,
    private readonly qualify: (records: readonly CodexCatalogRecord[]) => QualifiedCodexCatalog,
    defaultResolveBinary: () => Promise<BinaryResolution>,
  ) {
    this.key = `codex:${surface}`;
    this.sessionsRoot = options.sessionsRoot ?? join(homedir(), '.codex', 'sessions');
    this.archivedSessionsRoot =
      options.archivedSessionsRoot ?? join(homedir(), '.codex', 'archived_sessions');
    this.reader = options.reader ?? new CodexRolloutReader(this.sessionsRoot);
    this.archivedReader = new CodexRolloutReader(this.archivedSessionsRoot);
    this.resolveBinary = options.resolveBinary ?? defaultResolveBinary;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const suppliedCatalog = this.options.catalog;
    if (suppliedCatalog !== undefined) {
      this.catalog = suppliedCatalog;
    } else {
      const resolution = await this.resolveBinary();
      if (!resolution.ok) throw new Error(`codex-${this.surface}-${resolution.code}`);
      this.catalog = new CodexCatalogClient({
        binaryPath: resolution.binaryPath,
        targetSurface: this.surface,
      });
    }
    this.reader.start();
    this.archivedReader.start();
    try {
      await this.catalog.start();
      this.started = true;
    } catch (error) {
      this.reader.stop();
      this.archivedReader.stop();
      await this.catalog.stop();
      this.catalog = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.files.clear();
    this.unreadablePaths.clear();
    this.unavailableSourceIds.clear();
    this.reader.stop();
    this.archivedReader.stop();
    const catalog = this.catalog;
    this.catalog = undefined;
    await catalog?.stop();
  }

  async discover(): Promise<RuntimeDiscoveryResult> {
    if (!this.started || this.catalog === undefined) throw new Error(`${this.surface}-not-started`);
    // A single live page, newest first, is the whole product surface. Threads
    // beyond it are older than anything the dock can show, so the page is
    // complete even when the app-server reports a continuation cursor.
    const page = await this.catalog.listThreads({
      pageSize: RECENT_THREAD_DISCOVERY_WINDOW,
      maxPages: 1,
    });
    const records: readonly CodexCatalogRecord[] = page.records;
    let coverageIncomplete = page.coverageIncomplete === true;
    this.unavailableSourceIds.clear();
    const qualified = this.qualify(records);
    coverageIncomplete ||= qualified.issues.length > 0;

    const files = new Map<string, DiscoveredFile>();
    const seenThreads = new Set<string>();
    const sources: RuntimeMonitorSource[] = [];
    // Keep active sources before archive-only metadata sources so the reader's
    // continuation index remains stable while archived files are never replayed.
    // A missing catalog originator can be resolved only by the matching,
    // validated rollout SessionMeta, never by a filename or project path.
    const proofCandidates = new Set(qualified.needsRolloutProof ?? []);
    const orderedSessions = [...qualified.sessions, ...proofCandidates].sort(
      (left, right) =>
        Number(left.isArchived) - Number(right.isArchived) ||
        right.updatedAt - left.updatedAt ||
        (left.nativeId < right.nativeId ? -1 : left.nativeId > right.nativeId ? 1 : 0),
    );
    const pathCounts = new Map<string, number>();
    for (const session of orderedSessions) {
      if (session.rolloutPath !== undefined)
        pathCounts.set(session.rolloutPath, (pathCounts.get(session.rolloutPath) ?? 0) + 1);
    }
    for (const session of orderedSessions) {
      if (session.rolloutPath === undefined) {
        coverageIncomplete = true;
        continue;
      }
      if (this.unreadablePaths.has(resolve(session.rolloutPath))) {
        coverageIncomplete = true;
        continue;
      }
      if ((pathCounts.get(session.rolloutPath) ?? 0) > 1) {
        coverageIncomplete = true;
        continue;
      }
      const reader = session.isArchived ? this.archivedReader : this.reader;
      const meta = await reader.inspectSessionMeta(session.rolloutPath);
      if (meta === undefined) {
        coverageIncomplete = true;
        continue;
      }
      if (meta.nativeSessionId !== session.sessionId) {
        coverageIncomplete = true;
        continue;
      }
      if (
        proofCandidates.has(session) &&
        (meta.source !== 'vscode' || meta.originator !== 'Codex Desktop')
      ) {
        coverageIncomplete = true;
        continue;
      }
      const nativeSessionId = session.nativeId;
      if (seenThreads.has(nativeSessionId)) {
        coverageIncomplete = true;
        continue;
      }
      seenThreads.add(nativeSessionId);
      const root = session.isArchived ? this.archivedSessionsRoot : this.sessionsRoot;
      const cursorId = runtimeSourceId(cursorKeyForPath(root, session.rolloutPath));
      const id = session.isArchived ? `archived:${cursorId}` : cursorId;
      if (files.has(id)) {
        coverageIncomplete = true;
        continue;
      }
      files.set(id, {
        path: session.rolloutPath,
        nativeSessionId,
        rolloutSessionId: session.sessionId,
        isArchived: session.isArchived,
      });
      sources.push({
        id,
        nativeSessionId,
        ...(session.sessionId === nativeSessionId ? {} : { legacySessionId: session.sessionId }),
        title: session.name ?? session.projectBasename,
        updatedAt: session.updatedAt,
        isTopLevel: true,
        isArchived: session.isArchived,
        canOpen: false,
      });
    }
    this.files = files;
    return {
      complete: true,
      capturedAt: Date.now(),
      sources,
      ...(coverageIncomplete ? { coverageIncomplete: true } : {}),
    };
  }

  async capture(
    sources: readonly RuntimeMonitorSource[],
  ): Promise<readonly RuntimeMonitorSource[]> {
    const captured: RuntimeMonitorSource[] = [];
    for (const source of sources) {
      const file = this.files.get(source.id);
      if (file === undefined || file.nativeSessionId !== source.nativeSessionId) {
        throw new Error(`${this.surface}-source-changed`);
      }
      if (source.isArchived) {
        captured.push({ ...source, endOffset: 0 });
        continue;
      }
      const endOffset = await this.reader.captureRolloutEndOffset(file.path);
      if (endOffset === undefined) throw new Error(`${this.surface}-rollout-capture-failed`);
      captured.push({ ...source, endOffset });
    }
    return captured;
  }

  async read(request: RuntimeReadRequest): Promise<RuntimeReadResult> {
    const activeSources: RuntimeMonitorSource[] = [];
    const archivedSourceIds: string[] = [];
    const metadataOnlySourceIds: string[] = [];
    for (const source of request.sources) {
      const file = this.files.get(source.id);
      if (
        file === undefined ||
        file.nativeSessionId !== source.nativeSessionId ||
        file.isArchived !== source.isArchived
      ) {
        throw new Error(`${this.surface}-source-changed`);
      }
      if (source.isArchived) archivedSourceIds.push(source.id);
      else if (activeSources.length < MAX_RECENT_THREAD_LIMIT) activeSources.push(source);
      else metadataOnlySourceIds.push(source.id);
    }
    const sources: CodexRolloutSource[] = activeSources.map((source) => {
      const file = this.files.get(source.id)!;
      const record: SessionRecord | undefined =
        request.sessions[makeSessionId('codex', source.nativeSessionId)];
      return {
        path: file.path,
        session: {
          nativeSessionId: file.rolloutSessionId,
          threadId: source.nativeSessionId,
          surface: this.surface,
          isTopLevel: source.isTopLevel,
          ...(record?.activeTurnId === undefined ? {} : { activeTurnId: record.activeTurnId }),
          ...(record?.turnKey === undefined ? {} : { turnKey: record.turnKey }),
          inputRequests: record?.inputRequests ?? {},
        },
      };
    });
    const activeIds = new Set(activeSources.map((source) => source.id));
    const readerCursors = Object.fromEntries(
      Object.entries(request.cursors)
        .filter(([sourceId]) => activeIds.has(sourceId))
        .map(([sourceId, cursor]) => [readerCursorKey(sourceId), cursor]),
    );
    const readerCutoffs = Object.fromEntries(
      Object.entries(request.frozenCutoffs)
        .filter(([sourceId]) => activeIds.has(sourceId))
        .map(([sourceId, cutoff]) => [readerCursorKey(sourceId), cutoff]),
    );
    const result = await this.reader.read(sources, readerCursors, {
      sourceStart: Math.min(request.sourceStart ?? 0, sources.length),
      frozenCutoffs: readerCutoffs,
    });
    // Unknown non-structural records cannot be promoted into status events,
    // but they need not hide confirmed events from other records/sessions.
    // Identity, file, and replay-boundary failures still stop the surface.
    const fatal = result.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code !== 'file-reset' && !NONFATAL_COVERAGE_DIAGNOSTICS.has(diagnostic.code),
    );
    if (fatal.length > 0) {
      const sourceByPathKey = new Map(
        activeSources.flatMap((source) => {
          const file = this.files.get(source.id);
          return file === undefined ? [] : [[hashPath(resolve(file.path)), source] as const];
        }),
      );
      for (const diagnostic of fatal) {
        if (diagnostic.code !== 'oversized-line') continue;
        const source = sourceByPathKey.get(diagnostic.pathKey);
        const file = source === undefined ? undefined : this.files.get(source.id);
        if (source === undefined || file === undefined)
          throw new Error(`${this.surface}-rollout-coverage-issue`);
        this.unreadablePaths.add(resolve(file.path));
        this.unavailableSourceIds.add(source.id);
      }
      if (fatal.some((diagnostic) => diagnostic.code !== 'oversized-line'))
        throw new Error(`${this.surface}-rollout-coverage-issue`);
    }
    return {
      events: result.events.map((entry) => ({
        event: entry.event,
        historical: request.baseline || entry.baseline,
      })),
      cursors: Object.fromEntries(
        Object.entries(result.cursors).map(([key, cursor]) => [runtimeSourceId(key), cursor]),
      ),
      complete: result.complete,
      ...(this.unavailableSourceIds.size > 0 ||
      result.diagnostics.some((diagnostic) => NONFATAL_COVERAGE_DIAGNOSTICS.has(diagnostic.code))
        ? { coverageIncomplete: true }
        : {}),
      ...(this.unavailableSourceIds.size > 0 || metadataOnlySourceIds.length > 0
        ? {
            unavailableSourceIds: [
              ...new Set([...this.unavailableSourceIds, ...metadataOnlySourceIds]),
            ],
          }
        : {}),
      ...(result.nextSourceIndex === undefined ? {} : { nextSourceIndex: result.nextSourceIndex }),
      exhaustedSourceIds: [
        ...(result.exhaustedSourceIds ?? []).map(runtimeSourceId),
        ...archivedSourceIds,
        ...metadataOnlySourceIds,
      ],
    };
  }
}

export class CodexDesktopMonitor extends CodexSurfaceMonitor {
  constructor(options: CodexDesktopMonitorOptions = {}) {
    super(options, 'desktop', qualifyCodexDesktopCatalog, resolveBundledCodexBinary);
  }
}

import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeSessionId, type SessionRecord, type Surface } from '../../../shared/session';
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
import { CodexRolloutReader, cursorKeyForPath } from './rollout-reader';
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
  issues: readonly unknown[];
}

interface DiscoveredFile {
  path: string;
  nativeSessionId: string;
  rolloutSessionId: string;
  isArchived: boolean;
}

const MAX_CATALOG_CONTINUATIONS = 16;
const MAX_CATALOG_RECORDS = 1_024;
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
    this.reader.stop();
    this.archivedReader.stop();
    const catalog = this.catalog;
    this.catalog = undefined;
    await catalog?.stop();
  }

  async discover(): Promise<RuntimeDiscoveryResult> {
    if (!this.started || this.catalog === undefined) throw new Error(`${this.surface}-not-started`);
    const records: CodexCatalogRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let complete = false;
    let coverageIncomplete = false;
    for (let iteration = 0; iteration < MAX_CATALOG_CONTINUATIONS; iteration += 1) {
      const remaining = MAX_CATALOG_RECORDS - records.length;
      if (remaining < 1) throw new Error(`${this.surface}-catalog-incomplete`);
      const page = await this.catalog.listThreads({
        includeArchived: true,
        cursor,
        // Use the catalog client's bounded default: large app-server pages
        // can exceed its 1 MiB protocol-line limit before projection.
        maxPages: 16,
        maxRecords: remaining,
      });
      records.push(...page.records);
      coverageIncomplete ||= page.coverageIncomplete === true;
      if (page.complete) {
        complete = true;
        break;
      }
      if (page.nextCursor === null || seenCursors.has(page.nextCursor)) {
        throw new Error(`${this.surface}-catalog-incomplete`);
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (!complete) throw new Error(`${this.surface}-catalog-incomplete`);
    const qualified = this.qualify(records);
    coverageIncomplete ||= qualified.issues.length > 0;

    const files = new Map<string, DiscoveredFile>();
    const seenThreads = new Set<string>();
    const seenRolloutPaths = new Set<string>();
    const sources: RuntimeMonitorSource[] = [];
    // Keep active sources before archive-only metadata sources so the reader's
    // continuation index remains stable while archived files are never replayed.
    const orderedSessions = [...qualified.sessions].sort(
      (left, right) => Number(left.isArchived) - Number(right.isArchived),
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
      const nativeSessionId = session.nativeId;
      if (seenThreads.has(nativeSessionId) || seenRolloutPaths.has(session.rolloutPath)) {
        coverageIncomplete = true;
        continue;
      }
      seenThreads.add(nativeSessionId);
      seenRolloutPaths.add(session.rolloutPath);
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
      else activeSources.push(source);
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
    if (
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code !== 'file-reset' && !NONFATAL_COVERAGE_DIAGNOSTICS.has(diagnostic.code),
      )
    ) {
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
      ...(result.diagnostics.some((diagnostic) =>
        NONFATAL_COVERAGE_DIAGNOSTICS.has(diagnostic.code),
      )
        ? { coverageIncomplete: true }
        : {}),
      ...(result.nextSourceIndex === undefined ? {} : { nextSourceIndex: result.nextSourceIndex }),
      exhaustedSourceIds: [
        ...(result.exhaustedSourceIds ?? []).map(runtimeSourceId),
        ...archivedSourceIds,
      ],
    };
  }
}

export class CodexDesktopMonitor extends CodexSurfaceMonitor {
  constructor(options: CodexDesktopMonitorOptions = {}) {
    super(options, 'desktop', qualifyCodexDesktopCatalog, resolveBundledCodexBinary);
  }
}

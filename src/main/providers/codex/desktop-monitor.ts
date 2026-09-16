import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeSessionId, type SessionRecord } from '../../../shared/session';
import type {
  ProviderSurfaceMonitor,
  RuntimeDiscoveryResult,
  RuntimeMonitorSource,
  RuntimeReadRequest,
  RuntimeReadResult,
} from '../../runtime/coordinator';
import { resolveBundledCodexBinary } from './bundled-binary-resolver';
import { CodexCatalogClient, type CodexListThreadsResult } from './catalog-client';
import { qualifyCodexDesktopCatalog } from './catalog-qualification';
import { CodexRolloutReader, cursorKeyForPath } from './rollout-reader';
import type { CodexRolloutSource } from './events';

type Catalog = Pick<CodexCatalogClient, 'start' | 'stop' | 'listThreads'>;
type Reader = Pick<
  CodexRolloutReader,
  'start' | 'stop' | 'inspectSessionMeta' | 'captureRolloutEndOffset' | 'read'
>;

export interface CodexDesktopMonitorOptions {
  /** Test injection; production always resolves the signed app bundle. */
  catalog?: Catalog;
  reader?: Reader;
  sessionsRoot?: string;
  resolveBinary?: typeof resolveBundledCodexBinary;
}

interface DiscoveredFile {
  path: string;
  nativeSessionId: string;
}

function runtimeSourceId(cursorKey: string): string {
  if (!cursorKey.startsWith('codex:')) throw new Error('desktop-invalid-cursor-key');
  return cursorKey.slice('codex:'.length);
}

function readerCursorKey(sourceId: string): string {
  return `codex:${sourceId}`;
}

/** The only path-bearing state is transient and confined to the main process. */
export class CodexDesktopMonitor implements ProviderSurfaceMonitor {
  readonly key = 'codex:desktop' as const;
  private readonly sessionsRoot: string;
  private readonly reader: Reader;
  private readonly resolveBinary: typeof resolveBundledCodexBinary;
  private catalog: Catalog | undefined;
  private files = new Map<string, DiscoveredFile>();
  private started = false;

  constructor(private readonly options: CodexDesktopMonitorOptions = {}) {
    this.sessionsRoot = options.sessionsRoot ?? join(homedir(), '.codex', 'sessions');
    this.reader = options.reader ?? new CodexRolloutReader(this.sessionsRoot);
    this.resolveBinary = options.resolveBinary ?? resolveBundledCodexBinary;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const suppliedCatalog = this.options.catalog;
    if (suppliedCatalog !== undefined) {
      this.catalog = suppliedCatalog;
    } else {
      const resolution = await this.resolveBinary();
      if (!resolution.ok) throw new Error(`codex-desktop-${resolution.code}`);
      this.catalog = new CodexCatalogClient({ binaryPath: resolution.binaryPath });
    }
    this.reader.start();
    try {
      await this.catalog.start();
      this.started = true;
    } catch (error) {
      this.reader.stop();
      await this.catalog.stop();
      this.catalog = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.files.clear();
    this.reader.stop();
    const catalog = this.catalog;
    this.catalog = undefined;
    await catalog?.stop();
  }

  async discover(): Promise<RuntimeDiscoveryResult> {
    if (!this.started || this.catalog === undefined) throw new Error('desktop-not-started');
    const list: CodexListThreadsResult = await this.catalog.listThreads({ includeArchived: true });
    if (!list.complete) throw new Error('desktop-catalog-incomplete');
    const qualified = qualifyCodexDesktopCatalog(list.records);
    if (qualified.issues.length > 0) throw new Error('desktop-catalog-ambiguous');

    const files = new Map<string, DiscoveredFile>();
    const seenSessions = new Set<string>();
    const sources: RuntimeMonitorSource[] = [];
    for (const session of qualified.sessions) {
      if (session.rolloutPath === undefined) throw new Error('desktop-rollout-path-missing');
      const meta = await this.reader.inspectSessionMeta(session.rolloutPath);
      if (meta === undefined) throw new Error('desktop-rollout-identity-unavailable');
      const candidates = new Set([session.nativeId, session.sessionId]);
      if (!candidates.has(meta.nativeSessionId))
        throw new Error('desktop-rollout-identity-mismatch');
      const nativeSessionId = meta.nativeSessionId;
      if (seenSessions.has(nativeSessionId)) throw new Error('desktop-duplicate-session');
      seenSessions.add(nativeSessionId);
      const id = runtimeSourceId(cursorKeyForPath(this.sessionsRoot, session.rolloutPath));
      if (files.has(id)) throw new Error('desktop-duplicate-rollout');
      files.set(id, { path: session.rolloutPath, nativeSessionId });
      sources.push({
        id,
        nativeSessionId,
        title: session.projectBasename,
        updatedAt: session.updatedAt,
        isTopLevel: true,
        isArchived: session.isArchived,
        canOpen: false,
      });
    }
    this.files = files;
    return { complete: true, capturedAt: Date.now(), sources };
  }

  async capture(
    sources: readonly RuntimeMonitorSource[],
  ): Promise<readonly RuntimeMonitorSource[]> {
    const captured: RuntimeMonitorSource[] = [];
    for (const source of sources) {
      const file = this.files.get(source.id);
      if (file === undefined || file.nativeSessionId !== source.nativeSessionId) {
        throw new Error('desktop-source-changed');
      }
      const endOffset = await this.reader.captureRolloutEndOffset(file.path);
      if (endOffset === undefined) throw new Error('desktop-rollout-capture-failed');
      captured.push({ ...source, endOffset });
    }
    return captured;
  }

  async read(request: RuntimeReadRequest): Promise<RuntimeReadResult> {
    const sources: CodexRolloutSource[] = request.sources.map((source) => {
      const file = this.files.get(source.id);
      if (file === undefined || file.nativeSessionId !== source.nativeSessionId) {
        throw new Error('desktop-source-changed');
      }
      const record: SessionRecord | undefined =
        request.sessions[makeSessionId('codex', source.nativeSessionId)];
      return {
        path: file.path,
        session: {
          nativeSessionId: source.nativeSessionId,
          surface: 'desktop',
          isTopLevel: source.isTopLevel,
          ...(record?.activeTurnId === undefined ? {} : { activeTurnId: record.activeTurnId }),
          ...(record?.turnKey === undefined ? {} : { turnKey: record.turnKey }),
          inputRequests: record?.inputRequests ?? {},
        },
      };
    });
    const readerCursors = Object.fromEntries(
      Object.entries(request.cursors).map(([sourceId, cursor]) => [
        readerCursorKey(sourceId),
        cursor,
      ]),
    );
    const readerCutoffs = Object.fromEntries(
      Object.entries(request.frozenCutoffs).map(([sourceId, cutoff]) => [
        readerCursorKey(sourceId),
        cutoff,
      ]),
    );
    const result = await this.reader.read(sources, readerCursors, {
      sourceStart: request.sourceStart,
      frozenCutoffs: readerCutoffs,
    });
    if (result.diagnostics.length > 0) throw new Error('desktop-rollout-coverage-issue');
    return {
      events: result.events.map((entry) => ({
        event: entry.event,
        historical: request.baseline || entry.baseline,
      })),
      cursors: Object.fromEntries(
        Object.entries(result.cursors).map(([key, cursor]) => [runtimeSourceId(key), cursor]),
      ),
      complete: result.complete,
      ...(result.nextSourceIndex === undefined ? {} : { nextSourceIndex: result.nextSourceIndex }),
      ...(result.exhaustedSourceIds === undefined
        ? {}
        : { exhaustedSourceIds: result.exhaustedSourceIds.map(runtimeSourceId) }),
    };
  }
}

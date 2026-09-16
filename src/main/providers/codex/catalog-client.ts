import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';

const MAX_PENDING_REQUESTS = 32;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES = 16;
const DEFAULT_MAX_PAGES = 8;
const MAX_RECORDS = 1024;
const MAX_CURSOR_BYTES = 1024;
const MAX_ID_BYTES = 256;
const MAX_PATH_BYTES = 4096;
const MAX_LABEL_BYTES = 256;
const ARCHIVED_CURSOR_PREFIX = 'archived:';
const ARCHIVED_START_CURSOR = 'start';

const DIRECT_SOURCE_KINDS = new Set(['cli', 'vscode', 'exec', 'appServer', 'unknown']);

const SUBAGENT_STRING_KINDS = new Set(['review', 'compact', 'memory_consolidation']);

// The installed 0.154.0 protocol defaults an omitted/empty filter to
// interactive sources. Request every bounded enum value so discovery does not
// silently narrow the catalog before the later source qualifier runs. Custom
// session sources have no separate sourceKinds enum; their bounded discriminator
// remains in sourceEvidence and the qualifier decides how to handle it.
const DISCOVERY_SOURCE_KINDS = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
] as const;

const SUBAGENT_THREAD_SOURCE_KINDS = new Set([
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
]);

export type CodexCatalogDiagnosticCode =
  | 'invalid-options'
  | 'spawn-failed'
  | 'protocol-malformed'
  | 'protocol-oversized'
  | 'protocol-error'
  | 'request-capacity'
  | 'request-timeout'
  | 'disconnected'
  | 'server-stderr'
  | 'stopped'
  | 'termination-failed'
  | 'cursor-repeated'
  | 'cursor-omitted'
  | 'coverage-ambiguous';

export interface CodexCatalogDiagnostic {
  code: CodexCatalogDiagnosticCode;
}

export class CodexCatalogError extends Error {
  constructor(readonly code: CodexCatalogDiagnosticCode) {
    super(`Codex catalog ${code}.`);
    this.name = 'CodexCatalogError';
  }
}

export type CodexCatalogTargetSurface = 'desktop' | 'cli';

export interface CodexCatalogClientOptions {
  /** Absolute path to the trusted Codex executable supplied by the caller. */
  binaryPath: string;
  /** Optional caller-selected Codex home; this client never reads auth files. */
  codexHome?: string;
  /** Surface whose malformed records must remain coverage-ambiguous. */
  targetSurface?: CodexCatalogTargetSurface;
  requestTimeoutMs?: number;
  onDiagnostic?: (diagnostic: CodexCatalogDiagnostic) => void;
}

export interface CodexSourceEvidence {
  /** Raw protocol source discriminator after bounded validation; never a surface guess. */
  source: string;
  /** Bounded custom-source discriminator retained for later qualification. */
  customSource?: string;
  /** Optional analytics discriminator, retained only when it is a safe string. */
  threadSource?: string;
  originator?: string;
  cliVersion: string;
  isSubAgent: boolean;
}

/** Metadata needed by the later qualifier; no preview, turns, prompts, or outputs. */
export interface CodexCatalogRecord {
  nativeId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number;
  parentThreadId?: string;
  forkedFromId?: string;
  isEphemeral: boolean;
  /** Which list route produced this record; never inferred from source metadata. */
  isArchived?: boolean;
  projectBasename: string;
  rolloutPath?: string;
  sourceEvidence: CodexSourceEvidence;
}

export interface CodexListThreadsOptions {
  cursor?: string | null;
  pageSize?: number;
  maxPages?: number;
  maxRecords?: number;
  /** Include archived records after the complete unarchived route. */
  includeArchived?: boolean;
  /** Select one route. Defaults to the unarchived route. */
  archived?: boolean;
}

export interface CodexListThreadsResult {
  records: readonly CodexCatalogRecord[];
  nextCursor: string | null;
  pagesRead: number;
  /** False when bounded pagination stopped before exhausting the selected route(s). */
  complete: boolean;
  incompleteReason?: 'page-cap' | 'record-cap';
}

interface PendingRequest {
  reject: (error: CodexCatalogError) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ProtocolMessage {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ListPage {
  data: readonly unknown[];
  nextCursor: string | null;
  hasNextCursor: boolean;
}

interface ParsedSource {
  source: string;
  customSource?: string;
  isSubAgent: boolean;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function safeString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !hasControlCharacters(value) &&
    utf8Bytes(value) <= maxBytes
  );
}

function safeOptionalString(value: unknown, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return safeString(value, maxBytes) ? value : undefined;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function timestampMilliseconds(value: unknown): number | undefined {
  if (!safeTimestamp(value) || value > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    return undefined;
  }
  return value * 1_000;
}

function parseSource(value: unknown): ParsedSource | undefined {
  if (typeof value === 'string') {
    if (!DIRECT_SOURCE_KINDS.has(value)) return undefined;
    return {
      source: value,
      isSubAgent: false,
    };
  }
  if (!isRecord(value)) return undefined;
  const hasCustom = hasOwn(value, 'custom');
  const hasSubAgent = hasOwn(value, 'subAgent');
  if (hasCustom && hasSubAgent) return undefined;
  if (hasCustom && safeString(value.custom, MAX_LABEL_BYTES)) {
    return { source: 'custom', customSource: value.custom, isSubAgent: false };
  }
  if (!hasSubAgent) return undefined;
  if (typeof value.subAgent === 'string' && SUBAGENT_STRING_KINDS.has(value.subAgent)) {
    return {
      source:
        value.subAgent === 'review'
          ? 'subAgentReview'
          : value.subAgent === 'compact'
            ? 'subAgentCompact'
            : 'subAgentMemoryConsolidation',
      isSubAgent: true,
    };
  }
  if (!isRecord(value.subAgent)) return undefined;
  if (hasOwn(value.subAgent, 'other') && safeString(value.subAgent.other, MAX_LABEL_BYTES)) {
    return { source: 'subAgentOther', isSubAgent: true };
  }
  const threadSpawn = value.subAgent.thread_spawn;
  const threadSpawnDepth = isRecord(threadSpawn) ? threadSpawn.depth : undefined;
  if (
    hasOwn(value.subAgent, 'thread_spawn') &&
    isRecord(threadSpawn) &&
    safeString(threadSpawn.parent_thread_id, MAX_ID_BYTES) &&
    typeof threadSpawnDepth === 'number' &&
    Number.isSafeInteger(threadSpawnDepth) &&
    threadSpawnDepth >= 0 &&
    threadSpawnDepth <= 2_147_483_647
  ) {
    return { source: 'subAgentThreadSpawn', isSubAgent: true };
  }
  return undefined;
}

function projectThread(value: unknown, isArchived: boolean): CodexCatalogRecord | undefined {
  if (!isRecord(value)) return undefined;
  const nativeId = value.id;
  const sessionId = value.sessionId;
  const cliVersion = value.cliVersion;
  const cwd = value.cwd;
  const source = parseSource(value.source);
  const createdAt = timestampMilliseconds(value.createdAt);
  const updatedAt = timestampMilliseconds(value.updatedAt);
  if (
    !safeString(nativeId, MAX_ID_BYTES) ||
    !safeString(sessionId, MAX_ID_BYTES) ||
    !safeString(cliVersion, MAX_LABEL_BYTES) ||
    !safeString(cwd, MAX_PATH_BYTES) ||
    !isAbsolute(cwd) ||
    source === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    typeof value.ephemeral !== 'boolean'
  ) {
    return undefined;
  }

  const parentThreadId = safeOptionalString(value.parentThreadId, MAX_ID_BYTES);
  if (
    value.parentThreadId !== undefined &&
    value.parentThreadId !== null &&
    parentThreadId === undefined
  ) {
    return undefined;
  }
  const forkedFromId = safeOptionalString(value.forkedFromId, MAX_ID_BYTES);
  if (
    value.forkedFromId !== undefined &&
    value.forkedFromId !== null &&
    forkedFromId === undefined
  ) {
    return undefined;
  }
  const rolloutPath = safeOptionalString(value.path, MAX_PATH_BYTES);
  if (
    value.path !== undefined &&
    value.path !== null &&
    (rolloutPath === undefined || !isAbsolute(rolloutPath))
  ) {
    return undefined;
  }
  const recencyAt =
    value.recencyAt === undefined || value.recencyAt === null
      ? undefined
      : timestampMilliseconds(value.recencyAt);
  if (value.recencyAt !== undefined && value.recencyAt !== null && recencyAt === undefined) {
    return undefined;
  }
  const originator = safeOptionalString(value.originator, MAX_LABEL_BYTES);
  if (value.originator !== undefined && value.originator !== null && originator === undefined) {
    return undefined;
  }

  let threadSource: string | undefined;
  if (typeof value.threadSource === 'string') {
    if (!safeString(value.threadSource, MAX_LABEL_BYTES)) return undefined;
    threadSource = value.threadSource;
  }

  const projectBasename = basename(cwd) || cwd;
  if (!safeString(projectBasename, MAX_LABEL_BYTES)) return undefined;

  return {
    nativeId,
    sessionId,
    createdAt,
    updatedAt,
    ...(recencyAt === undefined ? {} : { recencyAt }),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(forkedFromId === undefined ? {} : { forkedFromId }),
    isEphemeral: value.ephemeral,
    isArchived,
    projectBasename,
    ...(rolloutPath === undefined ? {} : { rolloutPath }),
    sourceEvidence: {
      source: source.source,
      ...(source.customSource === undefined ? {} : { customSource: source.customSource }),
      ...(threadSource === undefined ? {} : { threadSource }),
      ...(originator === undefined ? {} : { originator }),
      cliVersion,
      isSubAgent:
        source.isSubAgent ||
        (threadSource !== undefined && SUBAGENT_THREAD_SOURCE_KINDS.has(threadSource)),
    },
  };
}

function parseListPage(value: unknown): ListPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const hasNextCursor = hasOwn(value, 'nextCursor');
  const nextCursor = value.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    !safeString(nextCursor, MAX_CURSOR_BYTES)
  ) {
    return undefined;
  }
  return {
    data: value.data,
    nextCursor: nextCursor ?? null,
    hasNextCursor,
  };
}

function hasConfidentSubagentEvidence(value: Record<string, unknown>): boolean {
  return (
    value.ephemeral === true ||
    safeString(value.parentThreadId, MAX_ID_BYTES) ||
    safeString(value.forkedFromId, MAX_ID_BYTES) ||
    (typeof value.threadSource === 'string' &&
      SUBAGENT_THREAD_SOURCE_KINDS.has(value.threadSource)) ||
    (isRecord(value.source) &&
      hasOwn(value.source, 'subAgent') &&
      !(hasOwn(value.source, 'custom') && hasOwn(value.source, 'subAgent')))
  );
}

/**
 * Inspect source evidence before validating any other metadata. A known
 * non-Desktop source must not turn malformed private fields into a coverage
 * warning. Only plausible Desktop records are eligible for that warning.
 */
function isConfidentlyUnrelatedDesktopSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.originator === 'Codex Desktop' && value.source !== 'vscode') return false;
  if (value.originator === 'codex_cli_rs' && value.source !== 'vscode') return true;
  if (hasConfidentSubagentEvidence(value)) return true;
  const source = value.source;
  if (typeof source === 'string') {
    return source !== 'vscode' && source !== 'unknown' && DIRECT_SOURCE_KINDS.has(source);
  }
  if (!isRecord(source)) return false;
  return hasOwn(source, 'subAgent') && !(hasOwn(source, 'custom') && hasOwn(source, 'subAgent'));
}

/**
 * Inspect source evidence for the CLI monitor before validating any other
 * metadata. CLI-originated records remain plausible even when their payload
 * is malformed; only clear Desktop or subagent evidence is unrelated.
 */
function isConfidentlyUnrelatedCliSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (hasConfidentSubagentEvidence(value)) return true;
  if (value.originator === 'codex_cli_rs') return false;
  if (value.originator === 'Codex Desktop') return value.source !== 'cli';

  const source = value.source;
  if (typeof source === 'string') {
    return source !== 'cli' && source !== 'unknown' && DIRECT_SOURCE_KINDS.has(source);
  }
  if (!isRecord(source)) return false;
  return hasOwn(source, 'subAgent') && !(hasOwn(source, 'custom') && hasOwn(source, 'subAgent'));
}

function isConfidentlyUnrelatedSource(
  value: unknown,
  targetSurface: CodexCatalogTargetSurface,
): boolean {
  return targetSurface === 'desktop'
    ? isConfidentlyUnrelatedDesktopSource(value)
    : isConfidentlyUnrelatedCliSource(value);
}

function validOption(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/**
 * Read-only Codex app-server catalog adapter.
 *
 * The process/request lifecycle and `thread/list` projection are adapted from
 * the Apache-2.0 codex-status-actions project; no Stream Deck runtime or source
 * payload fields are carried across this boundary.
 */
export class CodexCatalogClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readyChild: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private readonly ownedChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly terminations = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  private isStopped = true;
  private stopGeneration = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private lineBuffer = Buffer.alloc(0);
  private isDiscardingOversizedLine = false;
  private readonly targetSurface: CodexCatalogTargetSurface;

  constructor(private readonly options: CodexCatalogClientOptions) {
    const targetSurface = options.targetSurface ?? 'desktop';
    if (targetSurface !== 'desktop' && targetSurface !== 'cli') {
      throw new CodexCatalogError('invalid-options');
    }
    this.targetSurface = targetSurface;
    if (!isAbsolute(options.binaryPath) || !safeString(options.binaryPath, MAX_PATH_BYTES)) {
      throw new CodexCatalogError('invalid-options');
    }
    if (
      options.codexHome !== undefined &&
      (!isAbsolute(options.codexHome) || !safeString(options.codexHome, MAX_PATH_BYTES))
    ) {
      throw new CodexCatalogError('invalid-options');
    }
    if (
      options.requestTimeoutMs !== undefined &&
      !validOption(options.requestTimeoutMs, 1, MAX_REQUEST_TIMEOUT_MS)
    ) {
      throw new CodexCatalogError('invalid-options');
    }
  }

  get isConnected(): boolean {
    return Boolean(
      this.child &&
      this.readyChild === this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.isStopped,
    );
  }

  async start(): Promise<void> {
    const requestedStopGeneration = this.stopGeneration;
    if (this.stopping) await this.stopping;
    if (this.terminations.size > 0) await this.waitForTerminations();
    if (requestedStopGeneration !== this.stopGeneration) {
      throw new CodexCatalogError('stopped');
    }
    if (this.isConnected) return;
    if (this.starting) return this.starting;
    if (this.ownedChildren.size > 0) {
      this.report('termination-failed');
      throw new CodexCatalogError('termination-failed');
    }
    this.isStopped = false;
    const starting = this.startProcess().finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  async stop(): Promise<void> {
    this.stopGeneration += 1;
    if (this.stopping) return this.stopping;
    this.isStopped = true;
    this.child = undefined;
    this.readyChild = undefined;
    this.rejectPending('stopped');
    const starting = this.starting;
    const stopping = (async () => {
      await starting?.catch(() => undefined);
      await this.terminateOwnedChildren();
    })().finally(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    });
    this.stopping = stopping;
    return stopping;
  }

  async listThreads(options: CodexListThreadsOptions = {}): Promise<CodexListThreadsResult> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const maxRecords = options.maxRecords ?? MAX_RECORDS;
    if (
      !validOption(pageSize, 1, MAX_PAGE_SIZE) ||
      !validOption(maxPages, 1, MAX_PAGES) ||
      !validOption(maxRecords, 1, MAX_RECORDS)
    ) {
      this.report('invalid-options');
      throw new CodexCatalogError('invalid-options');
    }

    const includeArchived = options.includeArchived ?? false;
    let archivedRoute = options.archived ?? false;
    let cursor = options.cursor ?? null;
    if (cursor !== null && !safeString(cursor, MAX_CURSOR_BYTES)) {
      this.report('invalid-options');
      throw new CodexCatalogError('invalid-options');
    }
    if (cursor?.startsWith(ARCHIVED_CURSOR_PREFIX)) {
      archivedRoute = true;
      const encodedCursor = cursor.slice(ARCHIVED_CURSOR_PREFIX.length);
      cursor = encodedCursor === ARCHIVED_START_CURSOR ? null : encodedCursor;
      if (cursor !== null && !safeString(cursor, MAX_CURSOR_BYTES)) {
        this.report('invalid-options');
        throw new CodexCatalogError('invalid-options');
      }
    }

    await this.start();
    const child = this.child;
    if (child === undefined) {
      this.report('disconnected');
      throw new CodexCatalogError('disconnected');
    }

    const seenCursors = new Set<string>();
    if (cursor !== null) seenCursors.add(`${archivedRoute ? 'archived' : 'active'}:${cursor}`);
    const records: CodexCatalogRecord[] = [];
    let pagesRead = 0;
    let complete = false;
    let didReadArchivedPage = false;

    while (pagesRead < maxPages && records.length < maxRecords) {
      const limit = Math.min(pageSize, maxRecords - records.length);
      const raw = await this.request(child, 'thread/list', {
        cursor,
        limit,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: archivedRoute,
        modelProviders: [],
        sourceKinds: [...DISCOVERY_SOURCE_KINDS],
      });
      const page = parseListPage(raw);
      if (page === undefined || page.data.length > limit) {
        this.report('protocol-malformed');
        throw new CodexCatalogError('protocol-malformed');
      }
      if (!page.hasNextCursor) {
        this.report('cursor-omitted');
        throw new CodexCatalogError('cursor-omitted');
      }
      pagesRead += 1;
      if (archivedRoute) didReadArchivedPage = true;
      for (const value of page.data) {
        const record = projectThread(value, archivedRoute);
        if (record === undefined) {
          if (isConfidentlyUnrelatedSource(value, this.targetSurface)) continue;
          this.report('coverage-ambiguous');
          throw new CodexCatalogError('coverage-ambiguous');
        }
        records.push(record);
      }
      if (page.nextCursor === null) {
        cursor = null;
        if (includeArchived && !archivedRoute) {
          archivedRoute = true;
          continue;
        }
        complete = true;
        break;
      }
      const cursorKey = `${archivedRoute ? 'archived' : 'active'}:${page.nextCursor}`;
      if (seenCursors.has(cursorKey)) {
        this.report('cursor-repeated');
        throw new CodexCatalogError('cursor-repeated');
      }
      seenCursors.add(cursorKey);
      cursor = page.nextCursor;
    }

    if (!complete) {
      const archivedRouteNeedsStart = includeArchived && !didReadArchivedPage && cursor === null;
      const nextCursor =
        cursor === null
          ? archivedRouteNeedsStart
            ? `${ARCHIVED_CURSOR_PREFIX}${ARCHIVED_START_CURSOR}`
            : null
          : archivedRoute
            ? `${ARCHIVED_CURSOR_PREFIX}${cursor}`
            : cursor;
      return {
        records,
        nextCursor,
        pagesRead,
        complete: false,
        incompleteReason: records.length >= maxRecords ? 'record-cap' : 'page-cap',
      };
    }
    return { records, nextCursor: null, pagesRead, complete: true };
  }

  private async startProcess(): Promise<void> {
    this.lineBuffer = Buffer.alloc(0);
    this.isDiscardingOversizedLine = false;
    const env = {
      ...process.env,
      ...(this.options.codexHome === undefined ? {} : { CODEX_HOME: this.options.codexHome }),
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.binaryPath, ['app-server'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.report('spawn-failed');
      throw new CodexCatalogError('spawn-failed');
    }
    this.ownedChildren.add(child);
    if (this.isStopped) {
      await this.terminateOwned(child);
      throw new CodexCatalogError('stopped');
    }
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child === child) this.handleStdout(chunk);
    });
    child.stdout.on('error', () => {
      if (this.child === child) this.handleChildFailure(child);
    });
    child.stdin.on('error', () => {
      if (this.child === child) this.handleChildFailure(child);
    });
    child.stderr.on('data', () => {
      if (this.child === child) this.report('server-stderr');
    });
    child.stderr.on('error', () => {
      if (this.child === child) this.handleChildFailure(child);
    });
    child.on('error', () => {
      if (this.child === child) this.handleChildFailure(child);
    });
    child.once('close', () => {
      if (
        child.pid === undefined &&
        child.exitCode === null &&
        child.signalCode === null &&
        this.child === child
      ) {
        this.handleChildFailure(child);
      }
    });
    child.once('exit', () => {
      this.ownedChildren.delete(child);
      if (this.child === child) this.handleChildFailure(child);
    });

    try {
      const initializeResult = await this.request(child, 'initialize', {
        clientInfo: {
          name: 'agent-status-tiles',
          title: 'Agent Status Tiles',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      });
      if (this.isStopped) throw new CodexCatalogError('stopped');
      if (this.child !== child) throw new CodexCatalogError('disconnected');
      if (!isRecord(initializeResult)) {
        this.report('protocol-malformed');
        throw new CodexCatalogError('protocol-malformed');
      }
      this.notify(child, 'initialized', {});
      if (this.isStopped) throw new CodexCatalogError('stopped');
      if (this.child !== child) throw new CodexCatalogError('disconnected');
      this.readyChild = child;
    } catch (error) {
      if (this.child === child) {
        this.child = undefined;
        this.readyChild = undefined;
        this.rejectPending('disconnected');
      }
      await this.terminateOwned(child);
      throw error instanceof CodexCatalogError ? error : new CodexCatalogError('spawn-failed');
    }
  }

  private request(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (this.isStopped) {
      return Promise.reject(new CodexCatalogError('stopped'));
    }
    if (this.child !== child) return Promise.reject(new CodexCatalogError('disconnected'));
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      this.report('request-capacity');
      return Promise.reject(new CodexCatalogError('request-capacity'));
    }
    const id = this.nextRequestId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    if (Buffer.byteLength(payload, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      this.report('protocol-oversized');
      return Promise.reject(new CodexCatalogError('protocol-oversized'));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.report('request-timeout');
        reject(new CodexCatalogError('request-timeout'));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        child.stdin.write(payload, (error) => {
          if (error === undefined || error === null) return;
          const pending = this.pending.get(id);
          if (pending === undefined) return;
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          this.report('disconnected');
          pending.reject(new CodexCatalogError('disconnected'));
        });
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        this.report('disconnected');
        reject(new CodexCatalogError('disconnected'));
      }
    });
  }

  private notify(child: ChildProcessWithoutNullStreams, method: string, params: unknown): void {
    if (this.child !== child || this.isStopped) return;
    const payload = `${JSON.stringify({ method, params })}\n`;
    if (Buffer.byteLength(payload, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      this.report('protocol-oversized');
      return;
    }
    try {
      child.stdin.write(payload, (error) => {
        if (error !== undefined && error !== null && this.child === child) {
          this.handleChildFailure(child);
        }
      });
    } catch {
      if (this.child === child) this.handleChildFailure(child);
    }
  }

  private handleStdout(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(start, end);
      if (this.isDiscardingOversizedLine) {
        if (newline === -1) return;
        this.isDiscardingOversizedLine = false;
        start = newline + 1;
        continue;
      }
      if (this.lineBuffer.length + segment.length > MAX_PROTOCOL_LINE_BYTES) {
        this.lineBuffer = Buffer.alloc(0);
        this.report('protocol-oversized');
        if (newline === -1) this.isDiscardingOversizedLine = true;
      } else {
        if (segment.length > 0) {
          this.lineBuffer = Buffer.concat([this.lineBuffer, segment]);
        }
        if (newline !== -1) {
          const line = this.lineBuffer;
          this.lineBuffer = Buffer.alloc(0);
          this.handleLine(line);
        }
      }
      start = newline === -1 ? chunk.length : newline + 1;
    }
  }

  private handleLine(line: Buffer): void {
    let message: ProtocolMessage;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line);
      message = JSON.parse(decoded) as ProtocolMessage;
    } catch {
      this.report('protocol-malformed');
      return;
    }
    if (!isRecord(message)) {
      this.report('protocol-malformed');
      return;
    }
    if (!hasOwn(message, 'id')) return;
    if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) {
      this.report('protocol-malformed');
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (hasOwn(message, 'error')) {
      this.report('protocol-error');
      pending.reject(new CodexCatalogError('protocol-error'));
      return;
    }
    if (!hasOwn(message, 'result')) {
      this.report('protocol-malformed');
      pending.reject(new CodexCatalogError('protocol-malformed'));
      return;
    }
    pending.resolve(message.result);
  }

  private handleChildFailure(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    const code = this.readyChild === child ? 'disconnected' : 'spawn-failed';
    this.child = undefined;
    this.readyChild = undefined;
    this.rejectPending(code);
    this.report(code);
    const hasNeverSpawned =
      child.pid === undefined && child.exitCode === null && child.signalCode === null;
    if (hasNeverSpawned) {
      this.ownedChildren.delete(child);
      return;
    }
    void this.terminateOwned(child).catch(() => undefined);
  }

  private rejectPending(code: CodexCatalogDiagnosticCode): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexCatalogError(code));
    }
    this.pending.clear();
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (await this.waitForExit(child, 0)) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Escalate to SIGKILL after the bounded grace period.
    }
    if (await this.waitForExit(child, 1_000)) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // The bounded wait below determines whether the process actually exited.
    }
    if (await this.waitForExit(child, 1_000)) return;
    throw new CodexCatalogError('termination-failed');
  }

  private terminateOwned(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!this.ownedChildren.has(child)) return Promise.resolve();
    const existing = this.terminations.get(child);
    if (existing !== undefined) return existing;
    const termination = this.terminate(child)
      .catch((error) => {
        this.report('termination-failed');
        throw error instanceof CodexCatalogError
          ? error
          : new CodexCatalogError('termination-failed');
      })
      .finally(() => {
        this.terminations.delete(child);
      });
    this.terminations.set(child, termination);
    return termination;
  }

  private async waitForTerminations(): Promise<void> {
    while (this.terminations.size > 0) {
      await Promise.all([...this.terminations.values()]);
    }
  }

  private async terminateOwnedChildren(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.ownedChildren].map((child) => this.terminateOwned(child)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw failed.reason instanceof CodexCatalogError
        ? failed.reason
        : new CodexCatalogError('termination-failed');
    }
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    if (timeoutMs === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let isSettled = false;
      const finish = (hasExited: boolean) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        resolve(hasExited || child.exitCode !== null || child.signalCode !== null);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once('exit', onExit);
    });
  }

  private report(code: CodexCatalogDiagnosticCode): void {
    try {
      this.options.onDiagnostic?.({ code });
    } catch {
      // A diagnostic sink cannot affect process ownership or request handling.
    }
  }
}

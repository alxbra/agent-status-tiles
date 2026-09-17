import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { makeCursorKey, type FileCursor, type FileCursorMap } from '../../../shared/cursor';
import { isProvider, type Provider } from '../../../shared/session';

const MAX_TARGETS = 128;
const MAX_CURSOR_ENTRIES = 512;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_RECORDS = 4_096;
const MAX_DIAGNOSTICS = 128;
const MAX_ID_BYTES = 256;
const MAX_LABEL_BYTES = 256;
const MAX_PATH_BYTES = 4_096;
const MAX_CURSOR_IDENTITY_BYTES = 256;
const READ_CHUNK_BYTES = 16 * 1024;
const MAX_SNAPSHOT_ATTEMPTS = 3;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

const JOURNAL_SUFFIXES = ['.jsonl.3', '.jsonl.2', '.jsonl.1', '.jsonl'] as const;
const EVENT_NAMES = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'Elicitation',
  'ElicitationResult',
]);
const NOTIFICATION_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'auth_success',
  'elicitation_dialog',
  'elicitation_complete',
  'elicitation_response',
]);
const TOOL_NAMES = new Set(['AskUserQuestion', 'request_user_input']);
const HOSTS = new Set(['claude-desktop', 'terminal', 'iterm2', 'ghostty', 'warp']);
const ENTRYPOINTS = new Set(['claude-desktop', 'cli']);
const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact', 'fork']);
const END_REASONS = new Set(['clear', 'resume', 'logout', 'prompt_input_exit', 'other']);

export type HookJournalEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'Notification'
  | 'Stop'
  | 'StopFailure'
  | 'Elicitation'
  | 'ElicitationResult';

/** A coordinator-qualified journal name; no directory scanning is performed. */
export interface HookJournalTarget {
  provider: Provider;
  nativeSessionId: string;
  /** Hash basename without `.jsonl` or archive suffix. */
  baseName: string;
}

export interface HookJournalEvent {
  schemaVersion: 1;
  eventIdentity: string;
  provider: Provider;
  eventName: HookJournalEventName;
  sessionId: string;
  turnId?: string;
  promptId?: string;
  elicitationId?: string;
  toolCallId?: string;
  toolName?: 'AskUserQuestion' | 'request_user_input';
  timestamp: number;
  projectName?: string;
  projectId?: string;
  notificationType?:
    | 'permission_prompt'
    | 'idle_prompt'
    | 'auth_success'
    | 'elicitation_dialog'
    | 'elicitation_complete'
    | 'elicitation_response';
  stopHookActive?: boolean;
  /** Launching application, from an allowlisted macOS bundle identifier. */
  host?: 'claude-desktop' | 'terminal' | 'iterm2' | 'ghostty' | 'warp';
  /** Claude Code's own entrypoint marker, when it is one of the two local kinds. */
  entrypoint?: 'claude-desktop' | 'cli';
  /** The hook ran inside a subagent that shares the parent session ID. */
  isSubagent?: true;
  sessionSource?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
  endReason?: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other';
}

export type HookJournalDiagnosticCode =
  | 'unsafe-source'
  | 'source-not-regular'
  | 'source-oversized'
  | 'source-read-failed'
  | 'source-truncated'
  | 'record-malformed'
  | 'record-oversized'
  /** The cursor inode is absent; retained files may overlap prior progress. */
  | 'possible-retention-gap'
  | 'cursor-truncated'
  | 'read-limit'
  | 'cursor-limit'
  | 'source-unstable'
  | 'diagnostics-truncated';

export interface HookJournalDiagnostic {
  code: HookJournalDiagnosticCode;
  provider: Provider;
  sourceId: string;
}

export interface HookJournalReadResult {
  events: readonly HookJournalEvent[];
  cursors: FileCursorMap;
  diagnostics: readonly HookJournalDiagnostic[];
  /** Target index to pass back to read() when bounded work remains. */
  nextTargetIndex?: number;
}

export type HookJournalReaderErrorCode = 'invalid-options' | 'invalid-cursor';

export class HookJournalReaderError extends Error {
  constructor(readonly code: HookJournalReaderErrorCode) {
    super(`Hook journal reader ${code}.`);
    this.name = 'HookJournalReaderError';
  }
}

interface SourceSnapshot {
  path: string;
  identity: string;
  size: number;
  handle: Awaited<ReturnType<typeof open>>;
}

function isActiveSnapshot(snapshot: SourceSnapshot): boolean {
  return snapshot.path.endsWith('.jsonl');
}

type SnapshotSlotState = 'missing' | 'regular' | 'non-regular' | 'error';

interface SnapshotSlotObservation {
  path: string;
  state: SnapshotSlotState;
  errorCode?: string;
  identity?: string;
  snapshot?: SourceSnapshot;
}

interface MutableDiagnostics {
  values: HookJournalDiagnostic[];
  isTruncated: boolean;
}

interface ConsumedFile {
  events: HookJournalEvent[];
  cursor: FileCursor;
  bytesRead: number;
  isByteLimitReached: boolean;
  isRecordLimitReached: boolean;
  hasMore: boolean;
  hasPendingTail: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function isSafeString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !hasControlCharacters(value) &&
    getUtf8ByteLength(value) <= maxBytes
  );
}

function getOptionalString(
  value: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return isSafeString(value[key], maxBytes) ? value[key] : undefined;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidCursor(value: unknown): value is FileCursor {
  return (
    isRecord(value) &&
    Object.keys(value).every(
      (key) =>
        key === 'identity' ||
        key === 'offset' ||
        key === 'baselineUntilOffset' ||
        key === 'isDiscardingOversizedLine',
    ) &&
    (value.identity === '' || isSafeString(value.identity, MAX_CURSOR_IDENTITY_BYTES)) &&
    isValidTimestamp(value.offset) &&
    (value.baselineUntilOffset === undefined || isValidTimestamp(value.baselineUntilOffset)) &&
    (value.isDiscardingOversizedLine === undefined ||
      typeof value.isDiscardingOversizedLine === 'boolean')
  );
}

function isValidCursorKey(value: string): boolean {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return false;
  const provider = value.slice(0, separator);
  const sourceId = value.slice(separator + 1);
  return (
    isProvider(provider) &&
    isSafeString(sourceId, MAX_ID_BYTES) &&
    !isAbsolute(sourceId) &&
    !sourceId.includes('\\') &&
    !sourceId.split('/').includes('..')
  );
}

function getSourceIdentity(stats: { dev: bigint; ino: bigint }): string {
  return `dev:${stats.dev.toString()}:ino:${stats.ino.toString()}`;
}

function isContained(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative.length > 0 &&
    childRelative !== '..' &&
    !childRelative.startsWith('../') &&
    !isAbsolute(childRelative)
  );
}

function addDiagnostic(
  diagnostics: MutableDiagnostics,
  code: HookJournalDiagnosticCode,
  target: HookJournalTarget,
): void {
  if (diagnostics.values.length < MAX_DIAGNOSTICS) {
    diagnostics.values.push({ code, provider: target.provider, sourceId: target.baseName });
    return;
  }
  if (!diagnostics.isTruncated) {
    diagnostics.isTruncated = true;
    diagnostics.values[MAX_DIAGNOSTICS - 1] = {
      code: 'diagnostics-truncated',
      provider: target.provider,
      sourceId: target.baseName,
    };
  }
}

function createEventFromRecord(
  value: unknown,
  target: HookJournalTarget,
  eventIdentity: string,
): HookJournalEvent | undefined {
  if (!isRecord(value) || value.schema_version !== 1) return undefined;
  if (value.provider !== target.provider) return undefined;
  if (value.session_id !== target.nativeSessionId) return undefined;
  if (!isSafeString(value.event_name, 64) || !EVENT_NAMES.has(value.event_name)) return undefined;
  const eventName = value.event_name as HookJournalEventName;
  if (!isValidTimestamp(value.timestamp)) return undefined;

  const turnId = getOptionalString(value, 'turn_id', MAX_ID_BYTES);
  if (Object.hasOwn(value, 'turn_id') && turnId === undefined) return undefined;
  const promptId = getOptionalString(value, 'prompt_id', MAX_ID_BYTES);
  if (Object.hasOwn(value, 'prompt_id') && promptId === undefined) return undefined;
  const toolCallId = getOptionalString(value, 'tool_call_id', MAX_ID_BYTES);
  if (Object.hasOwn(value, 'tool_call_id') && toolCallId === undefined) return undefined;
  const projectName = getOptionalString(value, 'project_name', MAX_LABEL_BYTES);
  if (Object.hasOwn(value, 'project_name') && projectName === undefined) return undefined;
  const projectId = getOptionalString(value, 'project_id', MAX_ID_BYTES);
  if (
    Object.hasOwn(value, 'project_id') &&
    (projectId === undefined || !/^[a-f0-9]{64}$/u.test(projectId))
  ) {
    return undefined;
  }
  const stopHookActive = value.stop_hook_active;
  if (Object.hasOwn(value, 'stop_hook_active') && typeof stopHookActive !== 'boolean')
    return undefined;

  const elicitationId = getOptionalString(value, 'elicitation_id', MAX_ID_BYTES);
  if (
    Object.hasOwn(value, 'elicitation_id') &&
    (elicitationId === undefined ||
      !['Elicitation', 'ElicitationResult'].includes(value.event_name))
  ) {
    return undefined;
  }

  const toolName = getOptionalString(value, 'tool_name', 64);
  if (Object.hasOwn(value, 'tool_name') && (toolName === undefined || !TOOL_NAMES.has(toolName))) {
    return undefined;
  }

  const notificationType = getOptionalString(value, 'notification_type', MAX_LABEL_BYTES);
  if (
    Object.hasOwn(value, 'notification_type') &&
    (notificationType === undefined ||
      value.event_name !== 'Notification' ||
      !NOTIFICATION_TYPES.has(notificationType))
  ) {
    return undefined;
  }
  const typedToolName = toolName as HookJournalEvent['toolName'];
  const typedNotificationType = notificationType as HookJournalEvent['notificationType'];

  const host = getOptionalString(value, 'host', 64);
  if (Object.hasOwn(value, 'host') && (host === undefined || !HOSTS.has(host))) return undefined;
  const entrypoint = getOptionalString(value, 'entrypoint', 64);
  if (
    Object.hasOwn(value, 'entrypoint') &&
    (entrypoint === undefined || !ENTRYPOINTS.has(entrypoint))
  ) {
    return undefined;
  }
  if (Object.hasOwn(value, 'is_subagent') && value.is_subagent !== true) return undefined;
  const sessionSource = getOptionalString(value, 'session_source', 64);
  if (
    Object.hasOwn(value, 'session_source') &&
    (sessionSource === undefined ||
      eventName !== 'SessionStart' ||
      !SESSION_SOURCES.has(sessionSource))
  ) {
    return undefined;
  }
  const endReason = getOptionalString(value, 'end_reason', 64);
  if (
    Object.hasOwn(value, 'end_reason') &&
    (endReason === undefined || eventName !== 'SessionEnd' || !END_REASONS.has(endReason))
  ) {
    return undefined;
  }
  const typedHost = host as HookJournalEvent['host'];
  const typedEntrypoint = entrypoint as HookJournalEvent['entrypoint'];
  const typedSessionSource = sessionSource as HookJournalEvent['sessionSource'];
  const typedEndReason = endReason as HookJournalEvent['endReason'];

  return {
    schemaVersion: 1,
    eventIdentity,
    provider: target.provider,
    eventName,
    sessionId: target.nativeSessionId,
    ...(turnId === undefined ? {} : { turnId }),
    ...(promptId === undefined ? {} : { promptId }),
    ...(elicitationId === undefined ? {} : { elicitationId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(typedToolName === undefined ? {} : { toolName: typedToolName }),
    timestamp: value.timestamp,
    ...(projectName === undefined ? {} : { projectName }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(typedNotificationType === undefined ? {} : { notificationType: typedNotificationType }),
    ...(stopHookActive === undefined ? {} : { stopHookActive: stopHookActive as boolean }),
    ...(typedHost === undefined ? {} : { host: typedHost }),
    ...(typedEntrypoint === undefined ? {} : { entrypoint: typedEntrypoint }),
    ...(value.is_subagent === true ? { isSubagent: true as const } : {}),
    ...(typedSessionSource === undefined ? {} : { sessionSource: typedSessionSource }),
    ...(typedEndReason === undefined ? {} : { endReason: typedEndReason }),
  };
}

export function makeHookJournalBaseName(provider: Provider, nativeSessionId: string): string {
  return createHash('sha256')
    .update(provider)
    .update(Buffer.from([0]))
    .update(nativeSessionId)
    .digest('hex');
}

export class HookJournalReader {
  private readonly appDataPath: string;

  constructor(options: { appDataPath: string }) {
    if (!isAbsolute(options.appDataPath) || !isSafeString(options.appDataPath, MAX_PATH_BYTES)) {
      throw new HookJournalReaderError('invalid-options');
    }
    this.appDataPath = resolve(options.appDataPath);
  }

  async read(
    targets: readonly HookJournalTarget[],
    cursors: FileCursorMap = {},
    options: { startTargetIndex?: number } = {},
  ): Promise<HookJournalReadResult> {
    this.validateTargets(targets);
    this.validateCursorInput(cursors);
    const startTargetIndex = options.startTargetIndex ?? 0;
    if (
      !Number.isSafeInteger(startTargetIndex) ||
      startTargetIndex < 0 ||
      startTargetIndex > targets.length
    ) {
      throw new HookJournalReaderError('invalid-options');
    }

    const diagnostics: MutableDiagnostics = { values: [], isTruncated: false };
    const events: HookJournalEvent[] = [];
    const updatedCursors: Record<string, FileCursor> = { ...cursors };
    let totalBytes = 0;
    let totalRecords = 0;
    let nextTargetIndex: number | undefined;

    for (let targetIndex = startTargetIndex; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      const key = makeCursorKey(target.provider, target.baseName);
      const previous = Object.hasOwn(cursors, key) ? cursors[key] : undefined;
      if (
        !Object.hasOwn(updatedCursors, key) &&
        Object.keys(updatedCursors).length >= MAX_CURSOR_ENTRIES
      ) {
        addDiagnostic(diagnostics, 'cursor-limit', target);
        nextTargetIndex = targetIndex;
        break;
      }
      const result = await this.readTarget(
        target,
        previous,
        diagnostics,
        MAX_RECORDS - totalRecords,
        MAX_TOTAL_BYTES - totalBytes,
      );
      totalBytes += result.bytesRead;
      totalRecords += result.events.length;
      events.push(...result.events);
      if (result.cursor !== undefined) updatedCursors[key] = result.cursor;
      const isBounded =
        result.isBounded || totalBytes >= MAX_TOTAL_BYTES || totalRecords >= MAX_RECORDS;
      if (isBounded) addDiagnostic(diagnostics, 'read-limit', target);
      if (result.hasMore || isBounded) {
        nextTargetIndex = result.hasMore ? targetIndex : targetIndex + 1;
        break;
      }
    }

    if (nextTargetIndex !== undefined && nextTargetIndex >= targets.length) {
      nextTargetIndex = undefined;
    }
    return {
      events,
      cursors: updatedCursors,
      diagnostics: diagnostics.values,
      ...(nextTargetIndex === undefined ? {} : { nextTargetIndex }),
    };
  }

  private validateTargets(targets: readonly HookJournalTarget[]): void {
    if (!Array.isArray(targets) || targets.length > MAX_TARGETS) {
      throw new HookJournalReaderError('invalid-options');
    }
    const seen = new Set<string>();
    for (const target of targets) {
      if (
        !isRecord(target) ||
        !isProvider(target.provider) ||
        !isSafeString(target.nativeSessionId, MAX_ID_BYTES) ||
        !isSafeString(target.baseName, MAX_ID_BYTES) ||
        !/^[a-f0-9]{64}$/u.test(target.baseName) ||
        makeHookJournalBaseName(target.provider, target.nativeSessionId) !== target.baseName
      ) {
        throw new HookJournalReaderError('invalid-options');
      }
      const key = makeCursorKey(target.provider, target.baseName);
      if (seen.has(key)) throw new HookJournalReaderError('invalid-options');
      seen.add(key);
    }
  }

  private validateCursorInput(cursors: FileCursorMap): void {
    if (!isRecord(cursors) || Object.keys(cursors).length > MAX_CURSOR_ENTRIES) {
      throw new HookJournalReaderError('invalid-cursor');
    }
    for (const [key, value] of Object.entries(cursors)) {
      if (!isValidCursorKey(key) || !isValidCursor(value)) {
        throw new HookJournalReaderError('invalid-cursor');
      }
    }
  }

  private async readTarget(
    target: HookJournalTarget,
    previous: FileCursor | undefined,
    diagnostics: MutableDiagnostics,
    recordsRemaining: number,
    byteBudget: number,
  ): Promise<{
    events: HookJournalEvent[];
    cursor?: FileCursor;
    bytesRead: number;
    hasMore: boolean;
    isBounded: boolean;
  }> {
    const providerDirectory = join(this.appDataPath, 'journals', target.provider);
    if (!isContained(resolve(this.appDataPath, 'journals'), providerDirectory)) {
      addDiagnostic(diagnostics, 'unsafe-source', target);
      return { events: [], bytesRead: 0, hasMore: false, isBounded: false };
    }

    const isDirectoryReady = await this.isSafeProviderDirectory(
      providerDirectory,
      target,
      diagnostics,
    );
    if (!isDirectoryReady) return { events: [], bytesRead: 0, hasMore: false, isBounded: false };

    let snapshots: SourceSnapshot[] = [];
    let isStable = false;
    for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const observations: SnapshotSlotObservation[] = [];
      const attemptSnapshots: SourceSnapshot[] = [];
      for (const suffix of JOURNAL_SUFFIXES) {
        const path = join(providerDirectory, `${target.baseName}${suffix}`);
        if (!isContained(providerDirectory, path)) {
          addDiagnostic(diagnostics, 'unsafe-source', target);
          continue;
        }
        const observation = await this.observeSnapshotPath(path);
        const snapshot = await this.openSnapshot(path, target, diagnostics);
        observation.snapshot = snapshot;
        observations.push(observation);
        if (snapshot !== undefined) attemptSnapshots.push(snapshot);
      }
      if (await this.isStableSnapshotSet(observations)) {
        snapshots = attemptSnapshots;
        isStable = true;
        break;
      }
      await this.closeSnapshots(attemptSnapshots);
    }
    if (!isStable) {
      addDiagnostic(diagnostics, 'source-unstable', target);
      return { events: [], bytesRead: 0, hasMore: false, isBounded: false };
    }
    if (snapshots.length === 0) {
      // A prior inode disappearing without any retained file may indicate
      // loss, but the cursor cannot establish whether unread bytes existed.
      if (previous !== undefined && previous.identity !== '') {
        addDiagnostic(diagnostics, 'possible-retention-gap', target);
      }
      return { events: [], bytesRead: 0, hasMore: false, isBounded: false };
    }

    const hasTrustedPrevious = previous !== undefined && previous.identity !== '';
    const cursorIndex = !hasTrustedPrevious
      ? -1
      : snapshots.findIndex((snapshot) => snapshot.identity === previous.identity);
    if (hasTrustedPrevious && cursorIndex < 0) {
      addDiagnostic(diagnostics, 'possible-retention-gap', target);
    }

    const events: HookJournalEvent[] = [];
    let cursor: FileCursor | undefined;
    let hasStarted = !hasTrustedPrevious || cursorIndex < 0;
    const seenIdentities = new Set<string>();
    let bytesRead = 0;
    let hasMore = false;
    let isBounded = false;
    try {
      for (let index = 0; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index];
        if (seenIdentities.has(snapshot.identity)) continue;
        seenIdentities.add(snapshot.identity);
        if (!hasStarted) {
          if (snapshot.identity !== previous?.identity) continue;
          hasStarted = true;
        }
        const initialOffset =
          hasTrustedPrevious && snapshot.identity === previous?.identity ? previous.offset : 0;
        const consumed = await this.consumeSnapshot(
          snapshot,
          initialOffset,
          hasTrustedPrevious && snapshot.identity === previous?.identity ? previous : undefined,
          target,
          diagnostics,
          recordsRemaining - events.length,
          byteBudget - bytesRead,
        );
        bytesRead += consumed.bytesRead;
        events.push(...consumed.events);
        cursor = consumed.cursor;
        if (
          consumed.hasMore ||
          consumed.isRecordLimitReached ||
          consumed.hasPendingTail ||
          bytesRead >= byteBudget ||
          index + 1 >= snapshots.length
        ) {
          isBounded = consumed.isByteLimitReached || consumed.isRecordLimitReached;
          hasMore =
            consumed.hasMore ||
            (consumed.isRecordLimitReached && consumed.hasPendingTail) ||
            (index + 1 < snapshots.length &&
              (consumed.isRecordLimitReached || bytesRead >= byteBudget));
          break;
        }
      }
    } finally {
      await this.closeSnapshots(snapshots);
    }
    return { events, cursor, bytesRead, hasMore, isBounded };
  }

  private async isStableSnapshotSet(
    observations: readonly SnapshotSlotObservation[],
  ): Promise<boolean> {
    for (const observation of observations) {
      const current = await this.observeSnapshotPath(observation.path);
      if (
        current.state !== observation.state ||
        current.errorCode !== observation.errorCode ||
        current.identity !== observation.identity ||
        (observation.snapshot !== undefined &&
          observation.snapshot.identity !== observation.identity)
      ) {
        return false;
      }
    }
    return true;
  }

  private async observeSnapshotPath(path: string): Promise<SnapshotSlotObservation> {
    try {
      const current = await lstat(path, { bigint: true });
      return {
        path,
        state: current.isFile() && !current.isSymbolicLink() ? 'regular' : 'non-regular',
        ...(current.isFile() && !current.isSymbolicLink()
          ? { identity: getSourceIdentity(current) }
          : {}),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        path,
        state: code === 'ENOENT' ? 'missing' : 'error',
        ...(code === undefined ? {} : { errorCode: code }),
      };
    }
  }

  private async closeSnapshots(snapshots: readonly SourceSnapshot[]): Promise<void> {
    await Promise.all(snapshots.map((snapshot) => snapshot.handle.close().catch(() => undefined)));
  }

  private async isSafeProviderDirectory(
    path: string,
    target: HookJournalTarget,
    diagnostics: MutableDiagnostics,
  ): Promise<boolean> {
    const journalsPath = join(this.appDataPath, 'journals');
    let root;
    let journals;
    let provider;
    try {
      root = await lstat(this.appDataPath);
      journals = await lstat(journalsPath);
      provider = await lstat(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      addDiagnostic(
        diagnostics,
        code === 'ENOTDIR' || code === 'ELOOP' ? 'unsafe-source' : 'source-read-failed',
        target,
      );
      return false;
    }
    // A missing directory is normal for an uninitialized provider; existing
    // non-directory/symlink components are an unsafe source installation.
    const isDirectoryReady =
      root.isDirectory() &&
      !root.isSymbolicLink() &&
      journals.isDirectory() &&
      !journals.isSymbolicLink() &&
      provider.isDirectory() &&
      !provider.isSymbolicLink();
    if (!isDirectoryReady) {
      addDiagnostic(diagnostics, 'unsafe-source', target);
      return false;
    }
    return true;
  }

  private async openSnapshot(
    path: string,
    target: HookJournalTarget,
    diagnostics: MutableDiagnostics,
  ): Promise<SourceSnapshot | undefined> {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      addDiagnostic(diagnostics, 'source-read-failed', target);
      return undefined;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      addDiagnostic(
        diagnostics,
        metadata.isSymbolicLink() ? 'unsafe-source' : 'source-not-regular',
        target,
      );
      return undefined;
    }
    if (metadata.size > MAX_FILE_BYTES) {
      addDiagnostic(diagnostics, 'source-oversized', target);
      return undefined;
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NONBLOCK);
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) {
        await handle.close();
        addDiagnostic(diagnostics, 'source-not-regular', target);
        return undefined;
      }
      if (stats.size > BigInt(MAX_FILE_BYTES)) {
        await handle.close();
        addDiagnostic(diagnostics, 'source-oversized', target);
        return undefined;
      }
      const size = Number(stats.size);
      return {
        path,
        identity: getSourceIdentity(stats),
        size,
        handle,
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT')
        addDiagnostic(
          diagnostics,
          code === 'ELOOP' ? 'unsafe-source' : 'source-read-failed',
          target,
        );
      return undefined;
    }
  }

  private async consumeSnapshot(
    snapshot: SourceSnapshot,
    requestedOffset: number,
    previous: FileCursor | undefined,
    target: HookJournalTarget,
    diagnostics: MutableDiagnostics,
    recordsRemaining: number,
    byteBudget: number,
  ): Promise<ConsumedFile> {
    let offset = requestedOffset;
    const isActive = isActiveSnapshot(snapshot);
    let isDiscarding = previous?.isDiscardingOversizedLine ?? false;
    if (offset > snapshot.size) {
      addDiagnostic(diagnostics, 'cursor-truncated', target);
      offset = 0;
      isDiscarding = false;
    }
    const readResult = await this.readSnapshotBytes(
      snapshot,
      offset,
      byteBudget,
      target,
      diagnostics,
    );
    const bytes = readResult.bytes;
    const hasReachedSnapshotEof =
      !readResult.isByteLimitReached && offset + bytes.length === snapshot.size;
    if (!isActive && hasReachedSnapshotEof && bytes.length === 0) isDiscarding = false;
    const events: HookJournalEvent[] = [];
    let cursorOffset = offset;
    let lineStart = offset;
    let index = 0;
    let isRecordLimitReached = false;
    while (index < bytes.length) {
      if (events.length >= recordsRemaining) {
        isRecordLimitReached = true;
        cursorOffset = offset + index;
        break;
      }
      const newline = bytes.indexOf(0x0a, index);
      if (newline < 0) {
        const partialLength = bytes.length - index;
        if (!isActive && hasReachedSnapshotEof) {
          addDiagnostic(
            diagnostics,
            isDiscarding || partialLength + 1 > MAX_RECORD_BYTES
              ? 'record-oversized'
              : 'record-malformed',
            target,
          );
          isDiscarding = false;
          cursorOffset = offset + bytes.length;
        } else if (isDiscarding || partialLength + 1 > MAX_RECORD_BYTES) {
          if (!isDiscarding) addDiagnostic(diagnostics, 'record-oversized', target);
          isDiscarding = true;
          cursorOffset = offset + bytes.length;
        } else {
          cursorOffset = lineStart;
        }
        break;
      }
      const line = bytes.subarray(index, newline);
      const recordEnd = offset + newline + 1;
      if (isDiscarding) {
        isDiscarding = false;
        cursorOffset = recordEnd;
      } else if (line.byteLength + 1 > MAX_RECORD_BYTES) {
        addDiagnostic(diagnostics, 'record-oversized', target);
        cursorOffset = recordEnd;
      } else {
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        } catch {
          addDiagnostic(diagnostics, 'record-malformed', target);
          raw = undefined;
        }
        if (raw !== undefined) {
          const event = createEventFromRecord(raw, target, `${snapshot.identity}:${lineStart}`);
          if (event === undefined) addDiagnostic(diagnostics, 'record-malformed', target);
          else events.push(event);
        }
        cursorOffset = recordEnd;
      }
      lineStart = recordEnd;
      index = newline + 1;
      if (events.length >= recordsRemaining) {
        isRecordLimitReached = true;
        break;
      }
    }
    if (!isRecordLimitReached && index === bytes.length) {
      cursorOffset = offset + bytes.length;
      if (isDiscarding && bytes.length > 0 && bytes[bytes.length - 1] === 0x0a)
        isDiscarding = false;
    }
    const hasUnconsumedTail = isDiscarding || cursorOffset < snapshot.size;
    return {
      events,
      bytesRead: bytes.length,
      isByteLimitReached: readResult.isByteLimitReached,
      isRecordLimitReached,
      hasMore: readResult.isByteLimitReached,
      hasPendingTail: hasUnconsumedTail,
      cursor: {
        identity: snapshot.identity,
        offset: cursorOffset,
        ...(previous?.baselineUntilOffset === undefined
          ? {}
          : { baselineUntilOffset: previous.baselineUntilOffset }),
        ...(previous?.isDiscardingOversizedLine === undefined
          ? isDiscarding
            ? { isDiscardingOversizedLine: true }
            : {}
          : { isDiscardingOversizedLine: isDiscarding }),
      },
    };
  }

  private async readSnapshotBytes(
    snapshot: SourceSnapshot,
    offset: number,
    byteBudget: number,
    target: HookJournalTarget,
    diagnostics: MutableDiagnostics,
  ): Promise<{ bytes: Buffer; isByteLimitReached: boolean }> {
    const remaining = snapshot.size - offset;
    if (remaining <= 0) return { bytes: Buffer.alloc(0), isByteLimitReached: false };
    const readLimit = Math.min(remaining, Math.max(0, byteBudget));
    const bytes = Buffer.allocUnsafe(readLimit);
    let total = 0;
    while (total < readLimit) {
      const length = Math.min(READ_CHUNK_BYTES, readLimit - total);
      try {
        const result = await snapshot.handle.read(bytes, total, length, offset + total);
        if (result.bytesRead === 0) {
          addDiagnostic(diagnostics, 'source-truncated', target);
          break;
        }
        total += result.bytesRead;
      } catch {
        addDiagnostic(diagnostics, 'source-read-failed', target);
        break;
      }
    }
    return {
      bytes: bytes.subarray(0, total),
      isByteLimitReached: readLimit < remaining,
    };
  }
}

import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isCurrentTurn, isNewerTurn } from '../../sessions/reducer';
import type { InputRequest } from '../../../shared/session';
import type { TurnKey } from '../../../shared/session';
import { makeCursorKey } from '../../../shared/cursor';
import type { FileCursor } from '../../../shared/cursor';

import type {
  CodexDiagnostic,
  CodexRolloutEvent,
  CodexRolloutSource,
  CodexSessionQualification,
  CodexSessionEvent,
  CodexRolloutReadOptions,
  CodexSessionMetaInspection,
  RolloutReadResult,
} from './events';

export const READ_CHUNK_BYTES = 64 * 1024;
// Current Codex rollouts can include a single response record above 1 MiB.
// Keep the bound below the per-read budget while preserving status-bearing
// records that follow or accompany large local tool output.
export const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** A caller can invoke read again with the returned cursor to continue. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
export const MAX_EVENTS_PER_READ = 1024;
export const MAX_SOURCES_PER_READ = 128;

const MAX_STRING_BYTES = 256;
const MAX_DIAGNOSTICS = 128;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

interface JsonRecord {
  [key: string]: unknown;
}

interface PendingInput {
  turnId: string;
  requestedAt: number;
}

interface PendingOutput {
  turnId?: string;
  timestamp: number;
}

interface FileContext {
  pathKey: string;
  nativeSessionId: string;
  threadId: string;
  isTopLevel: boolean;
  surface: CodexSessionQualification['surface'];
  activeTurnId?: string;
  turnKey?: TurnKey;
  pendingInputs: Map<string, PendingInput>;
  pendingOutputs: Map<string, PendingOutput>;
  isQuarantined: boolean;
}

interface ReadBudget {
  bytesRead: number;
  eventsEmitted: number;
  isExhausted: boolean;
}

interface FileReadResult {
  cursor?: FileCursor;
  /** Complete records remain unread in this file and need the same source index. */
  hasMore: boolean;
  /** The source reached its immutable EOF boundary for this pass. */
  exhausted: boolean;
}

const MAX_META_SCAN_BYTES = 256 * 1024;
const MAX_META_SCAN_LINES = 128;

function clearTerminalContext(context: FileContext, turnId: string): void {
  if (context.activeTurnId !== turnId) return;
  context.pendingInputs.clear();
  context.pendingOutputs.clear();
  context.activeTurnId = undefined;
}

function isCurrentContextTurn(
  context: FileContext,
  turnId: string | undefined,
  timestamp: number,
): turnId is string {
  return (
    turnId !== undefined &&
    isCurrentTurn(
      {
        activeTurnId: context.activeTurnId,
        lastTurnStartedAt: context.turnKey?.timestamp ?? 0,
      },
      turnId,
      timestamp,
    )
  );
}

function canUseTurnContext(
  context: FileContext,
  turnId: string | undefined,
  timestamp: number,
): turnId is string {
  return (
    turnId !== undefined &&
    (context.activeTurnId === undefined || isCurrentContextTurn(context, turnId, timestamp))
  );
}

/**
 * Reads only rollout paths explicitly supplied by the catalog/discovery layer.
 * It does not scan the sessions directory and it does not start or resume a
 * Codex process. The caller owns cursor persistence and any future watcher.
 */
export class CodexRolloutReader {
  private isStopped = false;

  constructor(private readonly sessionsRoot: string) {}

  stop(): void {
    this.isStopped = true;
  }

  start(): void {
    this.isStopped = false;
  }

  /**
   * Capture a regular rollout's current EOF without exposing its path or
   * contents. The caller should retain this value for the whole baseline
   * replay and pass it in `frozenCutoffs` under the source cursor key.
   */
  async captureRolloutEndOffset(rolloutPath: string): Promise<number | undefined> {
    const validated = await this.validateFilePath(rolloutPath);
    if (!validated) return undefined;
    const file = await open(validated.candidate, constants.O_RDONLY | NOFOLLOW | NONBLOCK).catch(
      () => undefined,
    );
    if (!file) return undefined;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 0)
        return undefined;
      const current = await lstat(validated.candidate).catch(() => undefined);
      if (
        !current ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        fileIdentity(current) !== fileIdentity(metadata)
      )
        return undefined;
      return metadata.size;
    } catch {
      return undefined;
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  /**
   * Read only the bounded protocol SessionMeta identity and source evidence
   * from a validated rollout. No prompts, transcript, tool arguments, or
   * other payload fields cross this boundary.
   */
  async inspectSessionMeta(rolloutPath: string): Promise<CodexSessionMetaInspection | undefined> {
    const validated = await this.validateFilePath(rolloutPath);
    if (!validated) return undefined;
    const file = await open(validated.candidate, constants.O_RDONLY | NOFOLLOW | NONBLOCK).catch(
      () => undefined,
    );
    if (!file) return undefined;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) return undefined;
      const current = await lstat(validated.candidate).catch(() => undefined);
      if (
        !current ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        fileIdentity(current) !== fileIdentity(metadata)
      )
        return undefined;
      const readLength = Math.min(metadata.size, MAX_META_SCAN_BYTES);
      const buffer = Buffer.allocUnsafe(readLength);
      let total = 0;
      while (total < readLength) {
        const result = await file.read(buffer, total, readLength - total, total);
        if (result.bytesRead === 0) break;
        total += result.bytesRead;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total));
      } catch {
        return undefined;
      }
      const lines = text.split('\n');
      for (let index = 0; index < Math.min(lines.length, MAX_META_SCAN_LINES); index += 1) {
        const line = lines[index];
        if (!line || line.length > MAX_LINE_BYTES) continue;
        let record: unknown;
        try {
          record = JSON.parse(line.replace(/\r$/u, ''));
        } catch {
          continue;
        }
        const inspection = sessionMetaInspection(record);
        if (inspection) return inspection;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  async read(
    sources: readonly CodexRolloutSource[],
    storedCursors: Readonly<Record<string, FileCursor>> = {},
    options: CodexRolloutReadOptions = {},
  ): Promise<RolloutReadResult> {
    const events: CodexRolloutEvent[] = [];
    const diagnostics: CodexDiagnostic[] = [];
    const cursors: Record<string, FileCursor> = {};
    const exhaustedSourceIds: string[] = [];
    for (const [key, cursor] of Object.entries(storedCursors)) {
      // Cursor keys are relative source identifiers. Never carry an absolute
      // path back into a checkpoint, even if an older caller supplied one.
      const normalized = this.normalizeCursor(cursor);
      if (!path.isAbsolute(key) && normalized) cursors[key] = normalized;
    }
    if (this.isStopped) return { events, cursors, diagnostics, complete: false };

    if (!path.isAbsolute(this.sessionsRoot)) {
      this.addDiagnostic(diagnostics, 'invalid-root', hashPath(path.resolve(this.sessionsRoot)));
      return { events, cursors, diagnostics, complete: false };
    }
    const root = await this.safeRealpath(this.sessionsRoot);
    if (!root) {
      this.addDiagnostic(diagnostics, 'invalid-root', hashPath(this.sessionsRoot));
      return { events, cursors, diagnostics, complete: false };
    }
    const rootStat = await lstat(root).catch(() => undefined);
    if (!rootStat?.isDirectory()) {
      this.addDiagnostic(diagnostics, 'invalid-root', hashPath(root));
      return { events, cursors, diagnostics, complete: false };
    }

    const seenPaths = new Set<string>();
    const budget: ReadBudget = { bytesRead: 0, eventsEmitted: 0, isExhausted: false };
    const sourceStart = normalizeSourceStart(options.sourceStart);
    const sourceEnd = Math.min(sourceStart + MAX_SOURCES_PER_READ, sources.length);
    let nextSourceIndex: number | undefined =
      sourceStart < sources.length ? sourceStart : undefined;
    for (let sourceIndex = sourceStart; sourceIndex < sourceEnd; sourceIndex += 1) {
      const source = sources[sourceIndex];
      if (this.isStopped || budget.isExhausted) break;
      const rolloutPath = source?.path;
      if (typeof rolloutPath !== 'string') {
        this.addDiagnostic(diagnostics, 'invalid-path', hashPath('<invalid>'));
        nextSourceIndex = sourceIndex + 1;
        continue;
      }
      const candidate = path.resolve(rolloutPath);
      if (seenPaths.has(candidate)) {
        nextSourceIndex = sourceIndex + 1;
        continue;
      }
      seenPaths.add(candidate);
      const pathKey = hashPath(candidate);
      if (!path.isAbsolute(rolloutPath)) {
        this.addDiagnostic(diagnostics, 'invalid-path', pathKey);
        nextSourceIndex = sourceIndex + 1;
        continue;
      }
      if (!candidate.endsWith('.jsonl')) {
        this.addDiagnostic(diagnostics, 'unsupported-extension', pathKey);
        nextSourceIndex = sourceIndex + 1;
        continue;
      }

      const checked = await this.checkPath(candidate, root, pathKey, diagnostics);
      if (!checked) {
        nextSourceIndex = sourceIndex + 1;
        continue;
      }

      const resultKey = cursorKeyForPath(this.sessionsRoot, candidate);
      const inputCursor = storedCursors[resultKey];
      const initialCursor = this.normalizeCursor(inputCursor) ?? { offset: 0, identity: '' };
      const hasFrozenCutoff =
        options.frozenCutoffs !== undefined && Object.hasOwn(options.frozenCutoffs, resultKey);
      const frozenCutoff = hasFrozenCutoff
        ? normalizeCutoff(options.frozenCutoffs?.[resultKey])
        : undefined;
      if (hasFrozenCutoff && frozenCutoff === undefined) {
        this.addDiagnostic(diagnostics, 'invalid-cutoff', pathKey);
        nextSourceIndex = sourceIndex + 1;
        continue;
      }
      const session = this.normalizeSession(source?.session, pathKey, diagnostics);
      if (!session) {
        nextSourceIndex = sourceIndex + 1;
        continue;
      }
      const fileResult = await this.readFile(
        candidate,
        pathKey,
        session,
        initialCursor,
        options.firstInstallBaseline === true,
        frozenCutoff,
        events,
        diagnostics,
        budget,
      );
      if (fileResult.cursor) cursors[resultKey] = fileResult.cursor;
      if (fileResult.exhausted) exhaustedSourceIds.push(resultKey);
      if (fileResult.hasMore) {
        nextSourceIndex = sourceIndex;
        break;
      }
      nextSourceIndex = sourceIndex + 1;
    }
    if (nextSourceIndex !== undefined && nextSourceIndex < sources.length) {
      return {
        events,
        cursors,
        diagnostics,
        exhaustedSourceIds,
        complete: false,
        nextSourceIndex,
      };
    }
    return {
      events,
      cursors,
      diagnostics,
      exhaustedSourceIds,
      complete: true,
    };
  }

  private async checkPath(
    candidate: string,
    root: string,
    pathKey: string,
    diagnostics: CodexDiagnostic[],
  ): Promise<boolean> {
    const metadata = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') this.addDiagnostic(diagnostics, 'read-failed', pathKey);
      else this.addDiagnostic(diagnostics, 'missing-file', pathKey);
      return undefined;
    });
    if (!metadata) return false;
    if (metadata.isSymbolicLink()) {
      this.addDiagnostic(diagnostics, 'symlink-rejected', pathKey);
      return false;
    }
    if (!metadata.isFile()) {
      this.addDiagnostic(diagnostics, 'path-not-regular', pathKey);
      return false;
    }
    const resolved = await this.safeRealpath(candidate);
    if (!resolved || !isWithin(root, resolved)) {
      this.addDiagnostic(diagnostics, 'path-outside-root', pathKey);
      return false;
    }
    return true;
  }

  private async validateFilePath(
    rolloutPath: string,
  ): Promise<{ candidate: string; root: string } | undefined> {
    if (!path.isAbsolute(this.sessionsRoot) || !path.isAbsolute(rolloutPath)) return undefined;
    const candidate = path.resolve(rolloutPath);
    if (!candidate.endsWith('.jsonl')) return undefined;
    const root = await this.safeRealpath(this.sessionsRoot);
    if (!root) return undefined;
    const rootStat = await lstat(root).catch(() => undefined);
    if (!rootStat?.isDirectory()) return undefined;
    const diagnostics: CodexDiagnostic[] = [];
    if (!(await this.checkPath(candidate, root, hashPath(candidate), diagnostics)))
      return undefined;
    return { candidate, root };
  }

  private normalizeSession(
    value: unknown,
    pathKey: string,
    diagnostics: CodexDiagnostic[],
  ): CodexSessionQualification | undefined {
    const session = asRecord(value);
    const nativeSessionId = boundedString(session?.nativeSessionId);
    const threadId =
      session?.threadId === undefined ? nativeSessionId : boundedString(session.threadId);
    if (!nativeSessionId || !threadId) {
      this.addDiagnostic(diagnostics, 'missing-session-id', pathKey);
      return undefined;
    }
    if (session?.surface !== 'desktop' && session?.surface !== 'cli') {
      this.addDiagnostic(diagnostics, 'qualification-mismatch', pathKey);
      return undefined;
    }
    if (typeof session.isTopLevel !== 'boolean') {
      this.addDiagnostic(diagnostics, 'qualification-mismatch', pathKey);
      return undefined;
    }
    const activeTurnId =
      session.activeTurnId === undefined ? undefined : boundedString(session.activeTurnId);
    if (session.activeTurnId !== undefined && !activeTurnId) {
      this.addDiagnostic(diagnostics, 'missing-turn-id', pathKey);
    }
    const turnKey = normalizeTurnKey(session.turnKey);
    return {
      nativeSessionId,
      threadId,
      surface: session.surface,
      isTopLevel: session.isTopLevel,
      ...(activeTurnId ? { activeTurnId } : {}),
      ...(turnKey ? { turnKey } : {}),
      inputRequests: normalizeInputRequests(session.inputRequests),
    };
  }

  private async readFile(
    filePath: string,
    pathKey: string,
    session: CodexSessionQualification,
    initialCursor: FileCursor,
    firstInstallBaseline: boolean,
    frozenCutoff: number | undefined,
    events: CodexRolloutEvent[],
    diagnostics: CodexDiagnostic[],
    budget: ReadBudget,
  ): Promise<FileReadResult> {
    const file = await open(filePath, constants.O_RDONLY | NOFOLLOW | NONBLOCK).catch(
      () => undefined,
    );
    if (!file) {
      this.addDiagnostic(diagnostics, 'read-failed', pathKey);
      return { hasMore: false, exhausted: false };
    }
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) {
        this.addDiagnostic(diagnostics, 'path-not-regular', pathKey);
        return { hasMore: false, exhausted: false };
      }
      const identity = fileIdentity(metadata);
      // The pathname can be atomically replaced between checkPath() and open().
      // Refuse a handle whose inode is no longer the path's current inode so
      // old replacement bytes cannot be projected as live events.
      const pathMetadata = await lstat(filePath).catch(() => undefined);
      if (
        !pathMetadata ||
        pathMetadata.isSymbolicLink() ||
        !pathMetadata.isFile() ||
        fileIdentity(pathMetadata) !== identity
      ) {
        this.addDiagnostic(diagnostics, 'file-reset', pathKey);
        return { hasMore: false, exhausted: false };
      }
      const identityChanged =
        initialCursor.identity.length > 0 && initialCursor.identity !== identity;
      const cursorTruncated = initialCursor.offset > metadata.size;
      const reset = identityChanged || cursorTruncated;
      const cursor: FileCursor = reset ? { offset: 0, identity } : { ...initialCursor, identity };
      if (reset) {
        this.addDiagnostic(diagnostics, 'file-reset', pathKey);
      }

      // A cutoff captured from a prior inode/length is not evidence that bytes
      // in the new file are live. Replay the replacement as historical and
      // leave a safe cursor; the caller can qualify the replacement on a later
      // pass. This avoids promoting old replacement contents into unread state.
      const replacementReplay = reset;
      const boundaryWasTruncated =
        frozenCutoff !== undefined && frozenCutoff > metadata.size && !identityChanged;
      if (boundaryWasTruncated)
        this.addDiagnostic(diagnostics, 'fixed-boundary-truncated', pathKey);
      const snapshotEnd = metadata.size;
      // A replacement inode is never allowed to promote bytes beyond the old
      // cutoff as live. Replay the complete replacement snapshot historically;
      // a persisted baselineUntilOffset carries that larger boundary through
      // event/byte continuations even if the caller still supplies the old
      // frozen cutoff.
      const requestedBoundary = identityChanged
        ? snapshotEnd
        : Math.max(frozenCutoff ?? snapshotEnd, initialCursor.baselineUntilOffset ?? 0);
      const boundary = Math.min(requestedBoundary, snapshotEnd);
      const context: FileContext = {
        pathKey,
        nativeSessionId: session.nativeSessionId,
        threadId: session.threadId ?? session.nativeSessionId,
        isTopLevel: session.isTopLevel,
        surface: session.surface,
        ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
        ...(session.turnKey ? { turnKey: session.turnKey } : {}),
        pendingInputs: seedPendingInputs(session.inputRequests),
        pendingOutputs: new Map(),
        isQuarantined: false,
      };

      const baselineUntilOffset =
        cursor.baselineUntilOffset ??
        (frozenCutoff !== undefined && cursor.offset < boundary
          ? boundary
          : firstInstallBaseline && initialCursor.offset === 0 && initialCursor.identity === ''
            ? boundary
            : replacementReplay
              ? boundary
              : undefined);
      if (baselineUntilOffset !== undefined) cursor.baselineUntilOffset = baselineUntilOffset;

      let position = cursor.offset;
      let lineStart = position;
      let parts: Buffer[] = [];
      let lineLength = 0;
      let discarding = cursor.isDiscardingOversizedLine === true;
      let unprocessedCompleteLine = false;
      const fileEvents: CodexRolloutEvent[] = [];
      const eventsBeforeFile = budget.eventsEmitted;
      while (position < boundary && !this.isStopped && !budget.isExhausted) {
        const remainingBudget = MAX_READ_BYTES - budget.bytesRead;
        if (remainingBudget <= 0) {
          budget.isExhausted = true;
          break;
        }
        const length = Math.min(READ_CHUNK_BYTES, boundary - position, remainingBudget);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, position);
        if (bytesRead === 0) break;
        budget.bytesRead += bytesRead;
        const chunkStart = position;
        position += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        while (start < chunk.length && !budget.isExhausted) {
          const newline = chunk.indexOf(0x0a, start);
          const end = newline >= 0 ? newline : chunk.length;
          const segment = chunk.subarray(start, end);
          if (!discarding) {
            if (lineLength + segment.length > MAX_LINE_BYTES) {
              discarding = true;
              parts = [];
              lineLength = 0;
            } else if (segment.length > 0) {
              parts.push(Buffer.from(segment));
              lineLength += segment.length;
            }
          }
          if (newline < 0) break;

          const newlineOffset = chunkStart + newline;
          if (discarding) {
            this.addDiagnostic(diagnostics, 'oversized-line', pathKey, lineStart);
          } else {
            const line = Buffer.concat(parts, lineLength).toString('utf8');
            const estimatedEvents = canResolveInputOnLine(line, context) ? 2 : 1;
            if (budget.eventsEmitted + estimatedEvents > MAX_EVENTS_PER_READ) {
              budget.isExhausted = true;
              unprocessedCompleteLine = true;
              break;
            }
            const eventsBefore = fileEvents.length;
            this.parseLine(
              line,
              lineStart,
              context,
              baselineUntilOffset !== undefined && newlineOffset + 1 <= baselineUntilOffset,
              fileEvents,
              diagnostics,
            );
            budget.eventsEmitted += fileEvents.length - eventsBefore;
          }
          cursor.offset = newlineOffset + 1;
          lineStart = cursor.offset;
          parts = [];
          lineLength = 0;
          discarding = false;
          start = newline + 1;
        }
        if (budget.bytesRead >= MAX_READ_BYTES && position < boundary) budget.isExhausted = true;
      }
      if (discarding) {
        this.addDiagnostic(diagnostics, 'oversized-line', pathKey, lineStart);
        // A malformed line cannot become valid after it exceeds the bound.
        // Advance the cursor while retaining discard mode so a later batch
        // resumes at the current byte rather than rescanning its prefix.
        cursor.offset = position;
        cursor.isDiscardingOversizedLine = true;
      } else {
        delete cursor.isDiscardingOversizedLine;
      }
      if (baselineUntilOffset !== undefined && cursor.offset < baselineUntilOffset) {
        cursor.baselineUntilOffset = baselineUntilOffset;
      } else {
        delete cursor.baselineUntilOffset;
      }
      if (context.isQuarantined) {
        // A contradictory session_meta must never attribute events to the
        // qualified session. Retain the file identity but replay from its
        // beginning so a later catalog refresh revalidates the metadata.
        budget.eventsEmitted = eventsBeforeFile;
        return {
          cursor: {
            offset: 0,
            identity,
            ...(baselineUntilOffset === undefined ? {} : { baselineUntilOffset }),
          },
          hasMore: false,
          exhausted: false,
        };
      }
      events.push(...fileEvents);
      return {
        cursor,
        hasMore: !this.isStopped && (unprocessedCompleteLine || position < boundary),
        exhausted: !this.isStopped && !unprocessedCompleteLine && position >= boundary,
      };
    } catch {
      this.addDiagnostic(diagnostics, 'read-failed', pathKey);
      return { hasMore: false, exhausted: false };
    } finally {
      await file.close();
    }
  }

  private parseLine(
    line: string,
    lineOffset: number,
    context: FileContext,
    baseline: boolean,
    events: CodexRolloutEvent[],
    diagnostics: CodexDiagnostic[],
  ): void {
    if (context.isQuarantined || !line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.addDiagnostic(diagnostics, 'invalid-json', context.pathKey, lineOffset);
      return;
    }
    if (!isRecord(record)) {
      this.addDiagnostic(diagnostics, 'unsupported-item', context.pathKey, lineOffset);
      return;
    }
    const timestamp = parseTimestamp(record.timestamp);
    if (timestamp === undefined) {
      this.addDiagnostic(diagnostics, 'invalid-timestamp', context.pathKey, lineOffset);
      return;
    }
    const type = boundedString(record.type);
    if (!type) {
      this.addDiagnostic(diagnostics, 'unsupported-item', context.pathKey, lineOffset);
      return;
    }
    if (type === 'session_meta') {
      this.parseSessionMeta(record, context, diagnostics, lineOffset);
      return;
    }
    if (type === 'event_msg') {
      this.parseEventMessage(record, timestamp, context, baseline, events, diagnostics, lineOffset);
      return;
    }
    if (type === 'response_item') {
      this.parseResponseItem(record, timestamp, context, baseline, events, diagnostics, lineOffset);
      return;
    }
    if (IGNORED_RECORD_TYPES.has(type)) return;
    this.addDiagnostic(diagnostics, 'unsupported-item', context.pathKey, lineOffset);
  }

  private parseSessionMeta(
    record: JsonRecord,
    context: FileContext,
    diagnostics: CodexDiagnostic[],
    lineOffset: number,
  ): void {
    const payload = asRecord(record.payload);
    if (!payload) {
      this.addDiagnostic(diagnostics, 'missing-session-id', context.pathKey, lineOffset);
      context.isQuarantined = true;
      return;
    }
    // `id` is the protocol SessionMeta identity. Some current records also
    // contain `session_id`; the catalog owns that field's mapping and this
    // reader deliberately does not guess between the two.
    const sessionId = boundedString(payload.id);
    if (!sessionId) {
      this.addDiagnostic(diagnostics, 'missing-session-id', context.pathKey, lineOffset);
      context.isQuarantined = true;
      return;
    }
    if (sessionId && sessionId !== context.nativeSessionId) {
      this.addDiagnostic(diagnostics, 'session-identity-mismatch', context.pathKey, lineOffset);
      context.isQuarantined = true;
    }
    if (
      (isSubagentSource(payload.source) || isSubagentSource(payload.thread_source)) &&
      context.isTopLevel
    ) {
      this.addDiagnostic(diagnostics, 'qualification-mismatch', context.pathKey, lineOffset);
      context.isQuarantined = true;
    }
  }

  private parseEventMessage(
    record: JsonRecord,
    timestamp: number,
    context: FileContext,
    baseline: boolean,
    events: CodexRolloutEvent[],
    diagnostics: CodexDiagnostic[],
    lineOffset: number,
  ): void {
    const payload = asRecord(record.payload);
    const type = boundedString(payload?.type);
    if (!payload || !type) {
      this.addDiagnostic(diagnostics, 'unsupported-event', context.pathKey, lineOffset);
      return;
    }
    if (!context.nativeSessionId) {
      this.addDiagnostic(diagnostics, 'missing-session-id', context.pathKey, lineOffset);
      return;
    }
    const payloadTurnId = boundedString(payload.turn_id);
    if (payload.turn_id !== undefined && !payloadTurnId) {
      this.missingTurn(context, diagnostics, lineOffset);
      return;
    }
    if (type === 'task_started') {
      if (payloadTurnId) {
        const turnStarted = {
          type: 'turn-started' as const,
          sessionId: this.sessionId(context),
          turnId: payloadTurnId,
          timestamp,
        };
        if (!isNewerTurn({ turnKey: context.turnKey }, turnStarted)) return;
        context.activeTurnId = payloadTurnId;
        context.turnKey = { timestamp, turnId: payloadTurnId };
        context.pendingInputs.clear();
        context.pendingOutputs.clear();
        this.emit(turnStarted, context, baseline, events);
      } else this.missingTurn(context, diagnostics, lineOffset);
      return;
    }
    const turnId = payloadTurnId ?? context.activeTurnId;
    if (type === 'task_complete') {
      if (canUseTurnContext(context, turnId, timestamp)) {
        this.emit(
          {
            type: 'turn-completed',
            sessionId: this.sessionId(context),
            turnId,
            completionId: completionId(context.threadId, turnId, record.id),
            timestamp,
          },
          context,
          baseline,
          events,
        );
        clearTerminalContext(context, turnId);
      } else if (!turnId) this.missingTurn(context, diagnostics, lineOffset);
      return;
    }
    if (type === 'turn_aborted' || type === 'error') {
      if (canUseTurnContext(context, turnId, timestamp)) {
        this.emit(
          { type: 'turn-failed', sessionId: this.sessionId(context), turnId, timestamp },
          context,
          baseline,
          events,
        );
        clearTerminalContext(context, turnId);
      } else if (!turnId) this.missingTurn(context, diagnostics, lineOffset);
      return;
    }
    if (type === 'request_user_input') {
      this.emitInputRequested(
        payload,
        timestamp,
        turnId,
        context,
        baseline,
        events,
        diagnostics,
        lineOffset,
      );
      return;
    }
    if (type === 'turn_started' || type === 'turn_complete') {
      this.addDiagnostic(diagnostics, 'unsupported-event', context.pathKey, lineOffset);
      return;
    }
    if (IGNORED_EVENT_TYPES.has(type)) return;
    if (KNOWN_NONTERMINAL_EVENTS.has(type)) {
      this.emitActivity(context, timestamp, turnId, baseline, events);
      return;
    }
    this.addDiagnostic(diagnostics, 'unsupported-event', context.pathKey, lineOffset);
  }

  private parseResponseItem(
    record: JsonRecord,
    timestamp: number,
    context: FileContext,
    baseline: boolean,
    events: CodexRolloutEvent[],
    diagnostics: CodexDiagnostic[],
    lineOffset: number,
  ): void {
    const payload = asRecord(record.payload);
    const type = boundedString(payload?.type);
    if (!payload || !type) {
      this.addDiagnostic(diagnostics, 'unsupported-item', context.pathKey, lineOffset);
      return;
    }
    if (!context.nativeSessionId) {
      this.addDiagnostic(diagnostics, 'missing-session-id', context.pathKey, lineOffset);
      return;
    }
    const payloadTurnId = boundedString(payload.turn_id);
    if (payload.turn_id !== undefined && !payloadTurnId) {
      this.missingTurn(context, diagnostics, lineOffset);
      return;
    }
    const turnId = payloadTurnId ?? context.activeTurnId;
    const callId = boundedString(payload.call_id);
    if (type === 'function_call' && boundedString(payload.name) === 'request_user_input') {
      this.emitInputRequested(
        payload,
        timestamp,
        turnId,
        context,
        baseline,
        events,
        diagnostics,
        lineOffset,
      );
      return;
    }
    if (type === 'function_call_output') {
      if (!callId) {
        this.addDiagnostic(diagnostics, 'missing-call-id', context.pathKey, lineOffset);
        return;
      }
      if (!canUseTurnContext(context, turnId, timestamp)) return;
      const pending = context.pendingInputs.get(callId);
      if (pending && (!turnId || pending.turnId === turnId)) {
        context.pendingInputs.delete(callId);
        this.emit(
          {
            type: 'input-resolved',
            sessionId: this.sessionId(context),
            turnId: pending.turnId,
            callId,
            timestamp: Math.max(timestamp, pending.requestedAt),
          },
          context,
          baseline,
          events,
        );
      } else {
        context.pendingOutputs.set(callId, { turnId, timestamp });
      }
      return;
    }
    if (type === 'function_call') {
      // Ordinary tool calls are activity only. Their names and arguments may
      // contain private command or prompt data, so do not retain either.
      this.emitActivity(context, timestamp, turnId, baseline, events);
      return;
    }
    if (KNOWN_RESPONSE_ITEMS.has(type))
      this.emitActivity(context, timestamp, turnId, baseline, events);
    else this.addDiagnostic(diagnostics, 'unsupported-item', context.pathKey, lineOffset);
  }

  private emitInputRequested(
    payload: JsonRecord,
    timestamp: number,
    turnId: string | undefined,
    context: FileContext,
    baseline: boolean,
    events: CodexRolloutEvent[],
    diagnostics: CodexDiagnostic[],
    lineOffset: number,
  ): void {
    const callId = boundedString(payload.call_id);
    if (!callId) {
      this.addDiagnostic(diagnostics, 'missing-call-id', context.pathKey, lineOffset);
      return;
    }
    if (!turnId) {
      this.missingTurn(context, diagnostics, lineOffset);
      return;
    }
    if (!canUseTurnContext(context, turnId, timestamp)) return;
    context.pendingInputs.set(callId, { turnId, requestedAt: timestamp });
    this.emit(
      {
        type: 'input-requested',
        sessionId: this.sessionId(context),
        turnId,
        callId,
        timestamp,
      },
      context,
      baseline,
      events,
    );
    const pendingOutput = context.pendingOutputs.get(callId);
    if (pendingOutput && (!pendingOutput.turnId || pendingOutput.turnId === turnId)) {
      context.pendingOutputs.delete(callId);
      context.pendingInputs.delete(callId);
      this.emit(
        {
          type: 'input-resolved',
          sessionId: this.sessionId(context),
          turnId,
          callId,
          // A response item can precede its request in a replayed rollout.
          // The shared reducer rejects a resolution that predates its request,
          // so preserve the causal order of the correlated pair.
          timestamp: Math.max(pendingOutput.timestamp, timestamp),
        },
        context,
        baseline,
        events,
      );
    }
  }

  private emitActivity(
    context: FileContext,
    timestamp: number,
    turnId: string | undefined,
    baseline: boolean,
    events: CodexRolloutEvent[],
  ): void {
    this.emit(
      {
        type: 'activity',
        sessionId: this.sessionId(context),
        ...(turnId ? { turnId } : {}),
        timestamp,
      },
      context,
      baseline,
      events,
    );
  }

  private emit(
    event: CodexSessionEvent,
    context: FileContext,
    baseline: boolean,
    events: CodexRolloutEvent[],
  ): void {
    if (!context.nativeSessionId || this.isStopped) return;
    events.push({
      event,
      baseline,
      nativeSessionId: context.threadId,
      isTopLevel: context.isTopLevel,
      surface: context.surface,
    });
  }

  private sessionId(context: FileContext): string {
    return `codex:${context.threadId}`;
  }

  private missingTurn(context: FileContext, diagnostics: CodexDiagnostic[], offset: number): void {
    this.addDiagnostic(diagnostics, 'missing-turn-id', context.pathKey, offset);
  }

  private addDiagnostic(
    diagnostics: CodexDiagnostic[],
    code: CodexDiagnostic['code'],
    pathKey: string,
    offset?: number,
  ): void {
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    diagnostics.push({ code, pathKey, ...(offset === undefined ? {} : { offset }) });
  }

  private normalizeCursor(cursor: FileCursor | undefined): FileCursor | undefined {
    if (
      !cursor ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      !boundedString(cursor.identity)
    ) {
      return undefined;
    }
    const baselineUntilOffset = cursor.baselineUntilOffset;
    return {
      offset: cursor.offset,
      identity: cursor.identity,
      ...(typeof baselineUntilOffset === 'number' &&
      Number.isSafeInteger(baselineUntilOffset) &&
      baselineUntilOffset >= 0
        ? { baselineUntilOffset }
        : {}),
      ...(cursor.isDiscardingOversizedLine === true ? { isDiscardingOversizedLine: true } : {}),
    };
  }

  private async safeRealpath(target: string): Promise<string | undefined> {
    try {
      return await realpath(target);
    } catch {
      return undefined;
    }
  }
}

const KNOWN_NONTERMINAL_EVENTS = new Set([
  'agent_message',
  'agent_reasoning',
  'context_compacted',
  'item_completed',
  'stream_error',
  'user_message',
]);

// These current-version records are metadata/telemetry and have no status
// transition. Ignore them without inspecting or projecting their contents.
const IGNORED_RECORD_TYPES = new Set([
  'turn_context',
  'compacted',
  'token_usage_record',
  'world_state',
]);

const IGNORED_EVENT_TYPES = new Set(['token_count', 'thread_settings_applied']);

const KNOWN_RESPONSE_ITEMS = new Set([
  'message',
  'reasoning',
  'local_shell_call',
  'custom_tool_call',
  'custom_tool_call_output',
  'web_search_call',
  'ghost_snapshot',
  'compaction',
]);

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES
  ) {
    return undefined;
  }
  if (/\p{Cc}/u.test(value)) return undefined;
  return value;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_BYTES)
    return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeSourceStart(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeCutoff(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeTurnKey(value: unknown): TurnKey | undefined {
  const turnKey = asRecord(value);
  const turnId = boundedString(turnKey?.turnId);
  const timestamp = turnKey?.timestamp;
  if (
    !turnId ||
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    return undefined;
  }
  return { timestamp, turnId };
}

function canResolveInputOnLine(line: string, context: FileContext): boolean {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  const envelope = asRecord(record);
  const payload = asRecord(envelope?.payload);
  if (!envelope || !payload) return false;
  const envelopeType = boundedString(envelope.type);
  const payloadType = boundedString(payload.type);
  const isRequest =
    (envelopeType === 'event_msg' && payloadType === 'request_user_input') ||
    (envelopeType === 'response_item' &&
      payloadType === 'function_call' &&
      boundedString(payload.name) === 'request_user_input');
  if (!isRequest) return false;
  const callId = boundedString(payload.call_id);
  const turnId = boundedString(payload.turn_id) ?? context.activeTurnId;
  const pendingOutput = callId ? context.pendingOutputs.get(callId) : undefined;
  return Boolean(
    pendingOutput && turnId && (!pendingOutput.turnId || pendingOutput.turnId === turnId),
  );
}

function sessionMetaInspection(value: unknown): CodexSessionMetaInspection | undefined {
  const record = asRecord(value);
  if (boundedString(record?.type) !== 'session_meta') return undefined;
  const payload = asRecord(record?.payload);
  const nativeSessionId = boundedString(payload?.id);
  if (nativeSessionId === undefined) return undefined;
  const source = boundedString(payload?.source);
  const originator = boundedString(payload?.originator);
  return {
    nativeSessionId,
    ...(source === undefined ? {} : { source }),
    ...(originator === undefined ? {} : { originator }),
  };
}

function normalizeInputRequests(value: unknown): Readonly<Record<string, InputRequest>> {
  const normalized: Record<string, InputRequest> = Object.create(null) as Record<
    string,
    InputRequest
  >;
  if (!isRecord(value)) return normalized;
  for (const [callId, requestValue] of Object.entries(value)) {
    const boundedCallId = boundedString(callId);
    const request = asRecord(requestValue);
    const turnId = boundedString(request?.turnId);
    const requestedAt = request?.requestedAt;
    if (
      !boundedCallId ||
      !turnId ||
      typeof requestedAt !== 'number' ||
      !Number.isSafeInteger(requestedAt) ||
      requestedAt < 0
    ) {
      continue;
    }
    const resolvedAt = request?.resolvedAt;
    if (
      resolvedAt !== undefined &&
      (typeof resolvedAt !== 'number' || !Number.isSafeInteger(resolvedAt) || resolvedAt < 0)
    ) {
      continue;
    }
    normalized[boundedCallId] = {
      turnId,
      requestedAt,
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
    };
  }
  return normalized;
}

function seedPendingInputs(
  inputRequests: Readonly<Record<string, InputRequest>>,
): Map<string, PendingInput> {
  const pending = new Map<string, PendingInput>();
  for (const [callId, request] of Object.entries(inputRequests)) {
    if (request.resolvedAt === undefined) {
      pending.set(callId, { turnId: request.turnId, requestedAt: request.requestedAt });
    }
  }
  return pending;
}

function isSubagentSource(value: unknown): boolean {
  return value === 'subagent' || (isRecord(value) && Object.hasOwn(value, 'subagent'));
}

function fileIdentity(metadata: { dev: number; ino: number }): string {
  return `${String(metadata.dev)}:${String(metadata.ino)}`;
}

function hashPath(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex');
}

/** Stable cursor-map key; absolute user paths never need to be persisted. */
export function cursorKeyForPath(sessionsRoot: string, rolloutPath: string): string {
  const relative = path.relative(path.resolve(sessionsRoot), path.resolve(rolloutPath));
  return makeCursorKey('codex', relative.split(path.sep).join('/'));
}

function completionId(nativeSessionId: string, turnId: string, nativeEventId: unknown): string {
  const eventIdentity = boundedString(nativeEventId) ?? 'task_complete';
  return `codex:${createHash('sha256')
    .update(`complete\0${nativeSessionId}\0${turnId}\0${eventIdentity}`)
    .digest('hex')}`;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

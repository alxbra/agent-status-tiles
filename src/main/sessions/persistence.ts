import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { refreshSessionRecord } from './reducer';
import { type FileCursor, type FileCursorMap } from '../../shared/cursor';
import {
  createInitialSessionState,
  isProvider,
  isSurface,
  makeSessionId,
  type InputRequest,
  type Provider,
  type SessionRecord,
  type SessionState,
} from '../../shared/session';

const STORE_VERSION = 1;
const STORE_FILE = 'session-state.json';
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_ID_BYTES = 256;
const MAX_SESSION_ID_BYTES = MAX_ID_BYTES + 'claude:'.length;
const MAX_TITLE_BYTES = 256;
const MAX_SESSIONS = 1024;
const MAX_INPUT_REQUESTS = 128;
const MAX_CURSORS = 512;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

export interface SessionLoadResult {
  state: SessionState;
  cursors: FileCursorMap;
  baselineRequired: boolean;
  source: 'first-install' | 'restored';
}

export type SessionPersistenceErrorCode =
  'corrupt' | 'unsupported-version' | 'oversized' | 'unsafe' | 'io';

export class SessionPersistenceError extends Error {
  constructor(
    readonly code: SessionPersistenceErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SessionPersistenceError';
  }
}

interface StoredSessionRecord {
  id: string;
  provider: Provider;
  surface: SessionRecord['surface'];
  nativeSessionId: string;
  title: string;
  updatedAt: number;
  lastTurnStartedAt: number;
  completionId?: string;
  isTopLevel: boolean;
  isArchived: boolean;
  canOpen: boolean;
  activeTurnId?: string;
  turnKey?: SessionRecord['turnKey'];
  inputRequests: Readonly<Record<string, InputRequest>>;
  acknowledgedCompletionId?: string;
  isFailed: boolean;
  isErrorDismissed: boolean;
  metadataUpdatedAt: number;
}

interface StoredState {
  schemaVersion: typeof STORE_VERSION;
  sessions: Readonly<Record<string, StoredSessionRecord>>;
  order: readonly string[];
  cursors: FileCursorMap;
}

const writeQueues = new Map<string, Promise<void>>();

function own<T>(value: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function put<T>(value: Record<string, T>, key: string, item: T): void {
  Object.defineProperty(value, key, {
    configurable: true,
    enumerable: true,
    value: item,
    writable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function assertBoundedText(
  value: unknown,
  maxBytes: number,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new SessionPersistenceError('corrupt', `${label} must be a non-empty string.`);
  }
  if (hasControlCharacters(value)) {
    throw new SessionPersistenceError('unsafe', `${label} contains control characters.`);
  }
  if (utf8Bytes(value) > maxBytes) {
    throw new SessionPersistenceError('oversized', `${label} exceeds its storage bound.`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionPersistenceError('corrupt', `${label} must be a non-negative safe integer.`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new SessionPersistenceError('corrupt', `${label} must be boolean.`);
  }
}

function assertRelativeSourceId(value: unknown, label: string): asserts value is string {
  assertBoundedText(value, MAX_ID_BYTES, label);
  if (isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) {
    throw new SessionPersistenceError('unsafe', `${label} must be a relative source identifier.`);
  }
}

function cursorKeyParts(key: string): { provider: Provider; sourceId: string } | undefined {
  for (const provider of ['codex', 'claude'] as const) {
    const prefix = `${provider}:`;
    if (key.startsWith(prefix)) return { provider, sourceId: key.slice(prefix.length) };
  }
  return undefined;
}

function sanitizeCursorMap(value: unknown, label: string): FileCursorMap {
  if (!isRecord(value)) {
    throw new SessionPersistenceError('corrupt', `${label} must be an object.`);
  }
  const keys = Object.keys(value);
  const result: Record<string, FileCursor> = {};
  if (keys.length > MAX_CURSORS) {
    throw new SessionPersistenceError('oversized', `${label} exceeds the cursor count bound.`);
  }
  for (const key of keys) {
    const parts = cursorKeyParts(key);
    if (parts === undefined) {
      throw new SessionPersistenceError('unsafe', `${label} contains an invalid provider key.`);
    }
    assertRelativeSourceId(parts.sourceId, `${label}.${key}`);
    const cursor = own(value, key);
    if (
      !isRecord(cursor) ||
      !hasOnlyKeys(
        cursor,
        ['identity', 'offset'],
        ['baselineUntilOffset', 'isDiscardingOversizedLine'],
      )
    ) {
      throw new SessionPersistenceError('corrupt', `${label}.${key} is malformed.`);
    }
    assertBoundedText(cursor.identity, MAX_ID_BYTES, `${label}.${key}.identity`);
    assertTimestamp(cursor.offset, `${label}.${key}.offset`);
    if (cursor.baselineUntilOffset !== undefined) {
      assertTimestamp(cursor.baselineUntilOffset, `${label}.${key}.baselineUntilOffset`);
    }
    if (cursor.isDiscardingOversizedLine !== undefined) {
      assertBoolean(cursor.isDiscardingOversizedLine, `${label}.${key}.isDiscardingOversizedLine`);
    }
    put(result, key, {
      identity: cursor.identity,
      offset: cursor.offset,
      ...(cursor.baselineUntilOffset === undefined
        ? {}
        : { baselineUntilOffset: cursor.baselineUntilOffset }),
      ...(cursor.isDiscardingOversizedLine === undefined
        ? {}
        : { isDiscardingOversizedLine: cursor.isDiscardingOversizedLine }),
    });
  }
  return result;
}

function encodeInputRequests(record: SessionRecord): Readonly<Record<string, InputRequest>> {
  if (!isRecord(record.inputRequests)) {
    throw new SessionPersistenceError(
      'corrupt',
      `Session ${record.id}.inputRequests is malformed.`,
    );
  }
  const result: Record<string, InputRequest> = {};
  const entries = Object.keys(record.inputRequests);
  if (entries.length > MAX_INPUT_REQUESTS) {
    throw new SessionPersistenceError(
      'oversized',
      `Session ${record.id} exceeds the input-request count bound.`,
    );
  }
  for (const callId of entries) {
    assertBoundedText(callId, MAX_ID_BYTES, 'input request ID');
    const request = own(record.inputRequests, callId);
    if (!isRecord(request)) {
      throw new SessionPersistenceError('corrupt', `Input request ${callId} is malformed.`);
    }
    assertBoundedText(request.turnId, MAX_ID_BYTES, `input request ${callId}.turnId`);
    assertTimestamp(request.requestedAt, `input request ${callId}.requestedAt`);
    if (request.resolvedAt !== undefined) {
      assertTimestamp(request.resolvedAt, `input request ${callId}.resolvedAt`);
      if (request.resolvedAt < request.requestedAt) {
        throw new SessionPersistenceError('corrupt', `Input request ${callId} resolves too early.`);
      }
    }
    put(result, callId, {
      turnId: request.turnId,
      requestedAt: request.requestedAt,
      ...(request.resolvedAt === undefined ? {} : { resolvedAt: request.resolvedAt }),
    });
  }
  return result;
}

function encodeSession(record: SessionRecord): StoredSessionRecord {
  if (!isProvider(record.provider) || !isSurface(record.surface)) {
    throw new SessionPersistenceError(
      'corrupt',
      `Session ${record.id} has an unsupported provider/surface.`,
    );
  }
  assertBoundedText(record.id, MAX_SESSION_ID_BYTES, 'session ID');
  assertBoundedText(record.nativeSessionId, MAX_ID_BYTES, 'native session ID');
  assertBoundedText(record.title, MAX_TITLE_BYTES, 'session title');
  if (makeSessionId(record.provider, record.nativeSessionId) !== record.id) {
    throw new SessionPersistenceError('unsafe', `Session ${record.id} has mismatched identity.`);
  }
  assertTimestamp(record.updatedAt, `${record.id}.updatedAt`);
  assertTimestamp(record.lastTurnStartedAt, `${record.id}.lastTurnStartedAt`);
  assertTimestamp(record.metadataUpdatedAt, `${record.id}.metadataUpdatedAt`);
  assertBoolean(record.isTopLevel, `${record.id}.isTopLevel`);
  assertBoolean(record.isArchived, `${record.id}.isArchived`);
  assertBoolean(record.canOpen, `${record.id}.canOpen`);
  assertBoolean(record.isFailed, `${record.id}.isFailed`);
  assertBoolean(record.isErrorDismissed, `${record.id}.isErrorDismissed`);
  if (record.activeTurnId !== undefined) {
    assertBoundedText(record.activeTurnId, MAX_ID_BYTES, `${record.id}.activeTurnId`);
  }
  let turnKey: SessionRecord['turnKey'];
  if (record.turnKey !== undefined) {
    if (!isRecord(record.turnKey)) {
      throw new SessionPersistenceError('corrupt', `${record.id}.turnKey is malformed.`);
    }
    assertBoundedText(record.turnKey.turnId, MAX_ID_BYTES, `${record.id}.turnKey.turnId`);
    assertTimestamp(record.turnKey.timestamp, `${record.id}.turnKey.timestamp`);
    if (record.turnKey.timestamp !== record.lastTurnStartedAt) {
      throw new SessionPersistenceError('corrupt', `${record.id} has inconsistent turn timing.`);
    }
    if (record.activeTurnId !== undefined && record.activeTurnId !== record.turnKey.turnId) {
      throw new SessionPersistenceError('corrupt', `${record.id} has an inconsistent active turn.`);
    }
    turnKey = { timestamp: record.turnKey.timestamp, turnId: record.turnKey.turnId };
  } else if (record.lastTurnStartedAt !== 0) {
    throw new SessionPersistenceError('corrupt', `${record.id} is missing its turn key.`);
  }
  if (record.activeTurnId !== undefined && turnKey === undefined) {
    throw new SessionPersistenceError(
      'corrupt',
      `${record.id} has an active turn without a turn key.`,
    );
  }
  if (record.completionId !== undefined) {
    assertBoundedText(record.completionId, MAX_ID_BYTES, `${record.id}.completionId`);
    if (record.activeTurnId !== undefined) {
      throw new SessionPersistenceError(
        'corrupt',
        `${record.id} has an active and completed turn.`,
      );
    }
  }
  if (record.acknowledgedCompletionId !== undefined) {
    assertBoundedText(
      record.acknowledgedCompletionId,
      MAX_ID_BYTES,
      `${record.id}.acknowledgedCompletionId`,
    );
    if (record.acknowledgedCompletionId !== record.completionId) {
      throw new SessionPersistenceError(
        'corrupt',
        `${record.id} acknowledges the wrong completion.`,
      );
    }
  }
  if (record.isErrorDismissed && !record.isFailed) {
    throw new SessionPersistenceError('corrupt', `${record.id} dismisses a non-error.`);
  }
  if (record.isFailed && (record.activeTurnId !== undefined || record.completionId !== undefined)) {
    throw new SessionPersistenceError('corrupt', `${record.id} has conflicting failure state.`);
  }
  const inputRequests = encodeInputRequests(record);
  for (const request of Object.values(inputRequests)) {
    if (record.activeTurnId === undefined || request.turnId !== record.activeTurnId) {
      throw new SessionPersistenceError('corrupt', `${record.id} has an orphaned input request.`);
    }
  }
  return {
    id: record.id,
    provider: record.provider,
    surface: record.surface,
    nativeSessionId: record.nativeSessionId,
    title: record.title,
    updatedAt: record.updatedAt,
    lastTurnStartedAt: record.lastTurnStartedAt,
    ...(record.completionId === undefined ? {} : { completionId: record.completionId }),
    isTopLevel: record.isTopLevel,
    isArchived: record.isArchived,
    canOpen: record.canOpen,
    ...(record.activeTurnId === undefined ? {} : { activeTurnId: record.activeTurnId }),
    ...(turnKey === undefined ? {} : { turnKey }),
    inputRequests,
    ...(record.acknowledgedCompletionId === undefined
      ? {}
      : { acknowledgedCompletionId: record.acknowledgedCompletionId }),
    isFailed: record.isFailed,
    isErrorDismissed: record.isErrorDismissed,
    metadataUpdatedAt: record.metadataUpdatedAt,
  };
}

function encodeState(state: SessionState, cursors: FileCursorMap): StoredState {
  if (!isRecord(state.sessions)) {
    throw new SessionPersistenceError('corrupt', 'Session map is malformed.');
  }
  if (!Array.isArray(state.order)) {
    throw new SessionPersistenceError('corrupt', 'Session order is malformed.');
  }
  const sessionIds = Object.keys(state.sessions);
  if (sessionIds.length > MAX_SESSIONS) {
    throw new SessionPersistenceError('oversized', 'Session count exceeds the storage bound.');
  }
  const sessions: Record<string, StoredSessionRecord> = {};
  for (const id of sessionIds) {
    const record = own(state.sessions, id);
    if (!isRecord(record)) {
      throw new SessionPersistenceError('corrupt', `Session ${id} is malformed.`);
    }
    const sessionRecord = record as unknown as SessionRecord;
    if (sessionRecord.id !== id) {
      throw new SessionPersistenceError(
        'unsafe',
        `Session map key ${id} does not match its record.`,
      );
    }
    put(sessions, id, encodeSession(sessionRecord));
  }
  const order = [...state.order];
  if (order.length !== sessionIds.length || new Set(order).size !== order.length) {
    throw new SessionPersistenceError('corrupt', 'Session order does not match the session map.');
  }
  for (const id of order) {
    assertBoundedText(id, MAX_SESSION_ID_BYTES, 'session order ID');
    if (own(sessions, id) === undefined) {
      throw new SessionPersistenceError('corrupt', `Session order references unknown ID ${id}.`);
    }
  }
  return {
    schemaVersion: STORE_VERSION,
    sessions,
    order,
    cursors: sanitizeCursorMap(cursors, 'Cursor map'),
  };
}

function decodeInputRequests(
  value: unknown,
  sessionId: string,
  activeTurnId: string | undefined,
): Readonly<Record<string, InputRequest>> {
  if (!isRecord(value)) {
    throw new SessionPersistenceError('corrupt', `${sessionId}.inputRequests is malformed.`);
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_INPUT_REQUESTS) {
    throw new SessionPersistenceError('oversized', `${sessionId} has too many input requests.`);
  }
  const result: Record<string, InputRequest> = {};
  for (const callId of keys) {
    assertBoundedText(callId, MAX_ID_BYTES, `${sessionId} input request ID`);
    const request = own(value, callId);
    if (!isRecord(request) || !hasOnlyKeys(request, ['turnId', 'requestedAt'], ['resolvedAt'])) {
      throw new SessionPersistenceError('corrupt', `${sessionId}.${callId} request is malformed.`);
    }
    assertBoundedText(request.turnId, MAX_ID_BYTES, `${sessionId}.${callId}.turnId`);
    assertTimestamp(request.requestedAt, `${sessionId}.${callId}.requestedAt`);
    if (request.resolvedAt !== undefined) {
      assertTimestamp(request.resolvedAt, `${sessionId}.${callId}.resolvedAt`);
      if (request.resolvedAt < request.requestedAt) {
        throw new SessionPersistenceError('corrupt', `${sessionId}.${callId} resolves too early.`);
      }
    }
    if (activeTurnId === undefined || request.turnId !== activeTurnId) {
      throw new SessionPersistenceError('corrupt', `${sessionId}.${callId} is orphaned.`);
    }
    put(result, callId, {
      turnId: request.turnId,
      requestedAt: request.requestedAt,
      ...(request.resolvedAt === undefined ? {} : { resolvedAt: request.resolvedAt }),
    });
  }
  return result;
}

function decodeSession(value: unknown, id: string): SessionRecord {
  if (!isRecord(value)) {
    throw new SessionPersistenceError('corrupt', `Session ${id} is malformed.`);
  }
  const optional = ['completionId', 'activeTurnId', 'turnKey', 'acknowledgedCompletionId'] as const;
  const required = [
    'id',
    'provider',
    'surface',
    'nativeSessionId',
    'title',
    'updatedAt',
    'lastTurnStartedAt',
    'isTopLevel',
    'isArchived',
    'canOpen',
    'inputRequests',
    'isFailed',
    'isErrorDismissed',
    'metadataUpdatedAt',
  ] as const;
  if (!hasOnlyKeys(value, required, optional)) {
    throw new SessionPersistenceError('corrupt', `Session ${id} contains unsupported fields.`);
  }
  assertBoundedText(value.id, MAX_SESSION_ID_BYTES, `${id}.id`);
  assertBoundedText(value.nativeSessionId, MAX_ID_BYTES, `${id}.nativeSessionId`);
  assertBoundedText(value.title, MAX_TITLE_BYTES, `${id}.title`);
  if (!isProvider(value.provider) || !isSurface(value.surface)) {
    throw new SessionPersistenceError(
      'corrupt',
      `Session ${id} has an unsupported provider/surface.`,
    );
  }
  if (value.id !== id || makeSessionId(value.provider, value.nativeSessionId) !== id) {
    throw new SessionPersistenceError('unsafe', `Session ${id} has mismatched identity.`);
  }
  assertTimestamp(value.updatedAt, `${id}.updatedAt`);
  assertTimestamp(value.lastTurnStartedAt, `${id}.lastTurnStartedAt`);
  assertTimestamp(value.metadataUpdatedAt, `${id}.metadataUpdatedAt`);
  assertBoolean(value.isTopLevel, `${id}.isTopLevel`);
  assertBoolean(value.isArchived, `${id}.isArchived`);
  assertBoolean(value.canOpen, `${id}.canOpen`);
  assertBoolean(value.isFailed, `${id}.isFailed`);
  assertBoolean(value.isErrorDismissed, `${id}.isErrorDismissed`);
  if (value.completionId !== undefined) {
    assertBoundedText(value.completionId, MAX_ID_BYTES, `${id}.completionId`);
    if (value.activeTurnId !== undefined) {
      throw new SessionPersistenceError('corrupt', `${id} has an active and completed turn.`);
    }
  }
  if (value.acknowledgedCompletionId !== undefined) {
    assertBoundedText(
      value.acknowledgedCompletionId,
      MAX_ID_BYTES,
      `${id}.acknowledgedCompletionId`,
    );
    if (value.acknowledgedCompletionId !== value.completionId) {
      throw new SessionPersistenceError('corrupt', `${id} acknowledges the wrong completion.`);
    }
  }
  if (value.activeTurnId !== undefined) {
    assertBoundedText(value.activeTurnId, MAX_ID_BYTES, `${id}.activeTurnId`);
  }
  let turnKey: SessionRecord['turnKey'];
  if (value.turnKey !== undefined) {
    if (!isRecord(value.turnKey) || !hasOnlyKeys(value.turnKey, ['timestamp', 'turnId'])) {
      throw new SessionPersistenceError('corrupt', `${id}.turnKey is malformed.`);
    }
    assertTimestamp(value.turnKey.timestamp, `${id}.turnKey.timestamp`);
    assertBoundedText(value.turnKey.turnId, MAX_ID_BYTES, `${id}.turnKey.turnId`);
    if (value.turnKey.timestamp !== value.lastTurnStartedAt) {
      throw new SessionPersistenceError('corrupt', `${id} has inconsistent turn timing.`);
    }
    if (value.activeTurnId !== undefined && value.activeTurnId !== value.turnKey.turnId) {
      throw new SessionPersistenceError('corrupt', `${id} has an inconsistent active turn.`);
    }
    turnKey = { timestamp: value.turnKey.timestamp, turnId: value.turnKey.turnId };
  } else if (value.lastTurnStartedAt !== 0) {
    throw new SessionPersistenceError('corrupt', `${id} is missing its turn key.`);
  }
  if (value.activeTurnId !== undefined && turnKey === undefined) {
    throw new SessionPersistenceError('corrupt', `${id} has an active turn without a turn key.`);
  }
  if (value.isErrorDismissed && !value.isFailed) {
    throw new SessionPersistenceError('corrupt', `${id} dismisses a non-error.`);
  }
  if (value.isFailed && (value.activeTurnId !== undefined || value.completionId !== undefined)) {
    throw new SessionPersistenceError('corrupt', `${id} has conflicting failure state.`);
  }
  const inputRequests = decodeInputRequests(value.inputRequests, id, value.activeTurnId);
  return refreshSessionRecord({
    id,
    provider: value.provider,
    surface: value.surface,
    nativeSessionId: value.nativeSessionId,
    title: value.title,
    status: 'idle',
    updatedAt: value.updatedAt,
    lastTurnStartedAt: value.lastTurnStartedAt,
    ...(value.completionId === undefined ? {} : { completionId: value.completionId }),
    isTopLevel: value.isTopLevel,
    isArchived: value.isArchived,
    canOpen: value.canOpen,
    ...(value.activeTurnId === undefined ? {} : { activeTurnId: value.activeTurnId }),
    ...(turnKey === undefined ? {} : { turnKey }),
    inputRequests,
    ...(value.acknowledgedCompletionId === undefined
      ? {}
      : { acknowledgedCompletionId: value.acknowledgedCompletionId }),
    isFailed: value.isFailed,
    isErrorDismissed: value.isErrorDismissed,
    metadataUpdatedAt: value.metadataUpdatedAt,
  });
}

function decodeState(value: unknown): { state: SessionState; cursors: FileCursorMap } {
  if (!isRecord(value)) {
    throw new SessionPersistenceError('corrupt', 'Session state root must be an object.');
  }
  if (value.schemaVersion !== STORE_VERSION) {
    throw new SessionPersistenceError(
      'unsupported-version',
      `Session state schema version ${String(value.schemaVersion)} is unsupported.`,
    );
  }
  if (!hasOnlyKeys(value, ['schemaVersion', 'sessions', 'order', 'cursors'])) {
    throw new SessionPersistenceError('corrupt', 'Session state contains unsupported fields.');
  }
  if (!isRecord(value.sessions) || !Array.isArray(value.order)) {
    throw new SessionPersistenceError('corrupt', 'Session state collections are malformed.');
  }
  const sessionIds = Object.keys(value.sessions);
  if (sessionIds.length > MAX_SESSIONS) {
    throw new SessionPersistenceError('oversized', 'Session count exceeds the storage bound.');
  }
  if (
    value.order.length !== sessionIds.length ||
    new Set(value.order).size !== value.order.length
  ) {
    throw new SessionPersistenceError('corrupt', 'Session order does not match the session map.');
  }
  const sessions: Record<string, SessionRecord> = {};
  for (const id of sessionIds) {
    assertBoundedText(id, MAX_SESSION_ID_BYTES, 'session map key');
    put(sessions, id, decodeSession(own(value.sessions, id), id));
  }
  for (const id of value.order) {
    if (typeof id !== 'string') {
      throw new SessionPersistenceError('corrupt', 'Session order references an unknown ID.');
    }
    assertBoundedText(id, MAX_SESSION_ID_BYTES, 'session order ID');
    if (own(sessions, id) === undefined) {
      throw new SessionPersistenceError('corrupt', 'Session order references an unknown ID.');
    }
  }
  const cursors = sanitizeCursorMap(value.cursors, 'Cursor map');
  const state: SessionState = {
    sessions,
    order: [...value.order],
    providerHealth: {
      codex: { status: 'unavailable', updatedAt: 0 },
      claude: { status: 'unavailable', updatedAt: 0 },
    },
  };
  return { state, cursors };
}

function firstInstallResult(): SessionLoadResult {
  return {
    state: {
      ...createInitialSessionState(),
      providerHealth: {
        codex: { status: 'unavailable', updatedAt: 0 },
        claude: { status: 'unavailable', updatedAt: 0 },
      },
    },
    cursors: {},
    baselineRequired: true,
    source: 'first-install',
  };
}

async function ensurePrivateDataDirectory(dataDirectory: string): Promise<void> {
  if (!isAbsolute(dataDirectory)) {
    throw new SessionPersistenceError('unsafe', 'App-data path must be absolute.');
  }
  let mode: number;
  try {
    const existing = await lstat(dataDirectory);
    if (existing.isSymbolicLink()) {
      throw new SessionPersistenceError('unsafe', 'App-data directory must not be a symlink.');
    }
    if (!existing.isDirectory()) {
      throw new SessionPersistenceError('unsafe', 'App-data path is not a directory.');
    }
    mode = existing.mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SessionPersistenceError) throw error;
      throw new SessionPersistenceError('io', 'Unable to inspect app-data directory.', error);
    }
    try {
      await mkdir(dataDirectory, { mode: 0o700, recursive: true });
      mode = 0o700;
    } catch (mkdirError) {
      throw new SessionPersistenceError(
        'io',
        'Unable to create private app-data directory.',
        mkdirError,
      );
    }
  }
  if ((mode & 0o077) !== 0) {
    try {
      await chmod(dataDirectory, 0o700);
    } catch (error) {
      throw new SessionPersistenceError(
        'io',
        'Unable to enforce private app-data permissions.',
        error,
      );
    }
  }
}

async function assertStateFileNotSymlink(statePath: string): Promise<void> {
  try {
    const existing = await lstat(statePath);
    if (existing.isSymbolicLink()) {
      throw new SessionPersistenceError('unsafe', 'Session state file must not be a symlink.');
    }
    if (!existing.isFile()) {
      throw new SessionPersistenceError('unsafe', 'Session state path is not a regular file.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof SessionPersistenceError) throw error;
    throw new SessionPersistenceError('io', 'Unable to inspect session state file.', error);
  }
}

async function readBoundedState(statePath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(statePath, constants.O_RDONLY | NO_FOLLOW | NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new SessionPersistenceError('unsafe', 'Session state path is not a regular file.');
    }
    if (metadata.size > MAX_STATE_BYTES) {
      throw new SessionPersistenceError('oversized', 'Session state file exceeds the read bound.');
    }
    const buffer = Buffer.allocUnsafe(MAX_STATE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      if (bytesRead > MAX_STATE_BYTES) {
        throw new SessionPersistenceError(
          'oversized',
          'Session state file exceeds the read bound.',
        );
      }
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if (error instanceof SessionPersistenceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new SessionPersistenceError(
        'unsafe',
        'Session state file must not be a symlink.',
        error,
      );
    }
    throw new SessionPersistenceError('io', 'Unable to read session state file.', error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeAtomicState(dataDirectory: string, payload: string): Promise<void> {
  const statePath = join(dataDirectory, STORE_FILE);
  await assertStateFileNotSymlink(statePath);
  const temporaryPath = join(dataDirectory, `${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, statePath);
  } catch (error) {
    if (error instanceof SessionPersistenceError) throw error;
    throw new SessionPersistenceError('io', 'Unable to atomically save session state.', error);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function saveQueued(
  dataDirectory: string,
  state: SessionState,
  cursors: FileCursorMap,
): Promise<void> {
  const stored = encodeState(state, cursors);
  const payload = JSON.stringify(stored) + '\n';
  if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_BYTES) {
    throw new SessionPersistenceError('oversized', 'Session state exceeds the write bound.');
  }
  await ensurePrivateDataDirectory(dataDirectory);
  await writeAtomicState(dataDirectory, payload);
}

export function saveSessionState(
  appDataPath: string,
  state: SessionState,
  cursors: FileCursorMap = {},
): Promise<void> {
  if (!isAbsolute(appDataPath)) {
    return Promise.reject(new SessionPersistenceError('unsafe', 'App-data path must be absolute.'));
  }
  const dataDirectory = resolve(appDataPath);
  const previous = writeQueues.get(dataDirectory) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(() => saveQueued(dataDirectory, state, cursors));
  writeQueues.set(dataDirectory, queued);
  return queued.finally(() => {
    if (writeQueues.get(dataDirectory) === queued) writeQueues.delete(dataDirectory);
  });
}

export async function loadSessionState(appDataPath: string): Promise<SessionLoadResult> {
  if (!isAbsolute(appDataPath)) {
    throw new SessionPersistenceError('unsafe', 'App-data path must be absolute.');
  }
  const dataDirectory = resolve(appDataPath);
  try {
    const directory = await lstat(dataDirectory);
    if (directory.isSymbolicLink()) {
      throw new SessionPersistenceError('unsafe', 'App-data directory must not be a symlink.');
    }
    if (!directory.isDirectory()) {
      throw new SessionPersistenceError('unsafe', 'App-data path is not a directory.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return firstInstallResult();
    if (error instanceof SessionPersistenceError) throw error;
    throw new SessionPersistenceError('io', 'Unable to inspect app-data directory.', error);
  }

  const statePath = join(dataDirectory, STORE_FILE);
  try {
    await lstat(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return firstInstallResult();
    throw new SessionPersistenceError('io', 'Unable to inspect session state file.', error);
  }
  await assertStateFileNotSymlink(statePath);
  const payload = await readBoundedState(statePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new SessionPersistenceError('corrupt', 'Session state file is not valid JSON.', error);
  }
  const decoded = decodeState(parsed);
  return { ...decoded, baselineRequired: false, source: 'restored' };
}

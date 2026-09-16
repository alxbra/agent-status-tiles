import type { SessionEvent, SessionRecord } from '../../../shared/session';
import type { FileCursorMap } from '../../../shared/cursor';

/** The reader emits only the lifecycle subset of the shared SessionEvent contract. */

export type CodexSessionEvent = Extract<
  SessionEvent,
  {
    type:
      | 'turn-started'
      | 'activity'
      | 'input-requested'
      | 'input-resolved'
      | 'turn-completed'
      | 'turn-failed';
  }
>;

export interface CodexRolloutEvent {
  event: CodexSessionEvent;
  /** Initial history is explicitly marked so the consumer can avoid unread promotion. */
  baseline: boolean;
  nativeSessionId: string;
  isTopLevel: boolean;
  surface: CodexSessionQualification['surface'];
}

/**
 * Catalog-qualified metadata. The catalog owns the session identity and
 * surface classification; the rollout parser never guesses either from file
 * names or fork metadata. Its nativeSessionId must be qualified against the
 * protocol SessionMeta `id`; current alpha records may also carry a distinct
 * `session_id`, whose catalog mapping is intentionally outside this reader.
 */
export type CodexSessionQualification = Pick<
  SessionRecord,
  'nativeSessionId' | 'surface' | 'isTopLevel' | 'activeTurnId' | 'turnKey' | 'inputRequests'
> & { threadId?: string };

export interface CodexRolloutSource {
  path: string;
  session: CodexSessionQualification;
}

export type CodexDiagnosticCode =
  | 'invalid-root'
  | 'invalid-path'
  | 'path-outside-root'
  | 'missing-file'
  | 'symlink-rejected'
  | 'path-not-regular'
  | 'unsupported-extension'
  | 'read-failed'
  | 'invalid-json'
  | 'unsupported-item'
  | 'unsupported-event'
  | 'missing-session-id'
  | 'session-identity-mismatch'
  | 'qualification-mismatch'
  | 'missing-call-id'
  | 'missing-turn-id'
  | 'invalid-timestamp'
  | 'oversized-line'
  | 'file-reset'
  | 'invalid-cutoff'
  | 'fixed-boundary-truncated';

export interface CodexDiagnostic {
  code: CodexDiagnosticCode;
  /** Stable SHA-256 path identifier; raw paths and records never leave the reader. */
  pathKey: string;
  offset?: number;
}

/** Options for one bounded replay pass. Cutoff keys are cursorKeyForPath(). */
export interface CodexRolloutReadOptions {
  firstInstallBaseline?: boolean;
  sourceStart?: number;
  /**
   * Immutable byte EOFs captured by the caller before replay. A reader never
   * reads bytes at or beyond a cutoff, even when the source appends while it
   * is being consumed. Omitted keys use the EOF observed when the file opens.
   */
  frozenCutoffs?: Readonly<Record<string, number>>;
}

/** The only rollout metadata exposed to the catalog/qualification boundary. */
export interface CodexSessionMetaInspection {
  nativeSessionId: string;
}

export interface RolloutReadResult {
  events: readonly CodexRolloutEvent[];
  cursors: FileCursorMap;
  diagnostics: readonly CodexDiagnostic[];
  /** Index of the next explicit source when the source/event budget was hit. */
  nextSourceIndex?: number;
  /**
   * Source cursor keys whose fixed EOF was reached. This is explicit even if
   * the boundary ends in an unterminated line, where the byte cursor remains
   * at the beginning of that line for safe completion after a later append.
   */
  exhaustedSourceIds?: readonly string[];
  /** True when this pass consumed every source through its observed boundary. */
  complete: boolean;
}

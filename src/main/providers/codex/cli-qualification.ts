import type { CodexCatalogRecord } from './catalog-client';

/** Qualification exposes only fixed issue codes and never private metadata. */
export type CodexCliQualificationIssueCode = 'coverage-ambiguous';

export interface CodexCliQualificationIssue {
  code: CodexCliQualificationIssueCode;
}

export interface CodexCliQualificationSession {
  nativeId: string;
  sessionId: string;
  projectBasename: string;
  name?: string;
  rolloutPath?: string;
  createdAt: number;
  updatedAt: number;
  surface: 'cli';
  isTopLevel: true;
  isArchived: boolean;
}

export type CodexCliQualificationDecision =
  | { kind: 'qualified'; session: CodexCliQualificationSession }
  | { kind: 'skip' }
  | { kind: 'ambiguous'; issue: CodexCliQualificationIssue };

export interface CodexCliCatalogQualification {
  sessions: readonly CodexCliQualificationSession[];
  issues: readonly CodexCliQualificationIssue[];
}

const CODEX_CLI_ORIGINATOR = 'codex_cli_rs';
const CODEX_DESKTOP_ORIGINATOR = 'Codex Desktop';

// These source values identify another Codex surface or a child task. They
// must never be promoted to CLI sessions, even if another field is malformed.
const CONFIDENTLY_UNRELATED_SOURCES = new Set([
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentMemoryConsolidation',
  'subAgentThreadSpawn',
  'subAgentOther',
]);

function ambiguous(): CodexCliQualificationDecision {
  return { kind: 'ambiguous', issue: { code: 'coverage-ambiguous' } };
}

/**
 * Qualify one metadata-only catalog record for the Codex CLI surface.
 *
 * The exact `cli`/`codex_cli_rs` pair is required. A missing or contradictory
 * discriminator is never guessed into a session; evidence that could still
 * describe a CLI record becomes a fixed coverage issue instead.
 */
export function qualifyCodexCliRecord(record: CodexCatalogRecord): CodexCliQualificationDecision {
  const source = record.sourceEvidence.source;
  const originator = record.sourceEvidence.originator;

  // Child, forked, ephemeral, and explicitly subagent records are not
  // top-level sessions even when their source pair resembles the CLI pair.
  if (
    record.isEphemeral ||
    record.sourceEvidence.isSubAgent ||
    record.parentThreadId !== undefined
  ) {
    return { kind: 'skip' };
  }

  if (source === 'cli') {
    if (originator === CODEX_CLI_ORIGINATOR) {
      return {
        kind: 'qualified',
        session: {
          nativeId: record.nativeId,
          sessionId: record.sessionId,
          projectBasename: record.projectBasename,
          ...(record.name === undefined ? {} : { name: record.name }),
          ...(record.rolloutPath === undefined ? {} : { rolloutPath: record.rolloutPath }),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          surface: 'cli',
          isTopLevel: true,
          isArchived: record.isArchived ?? false,
        },
      };
    }
    // A known Desktop originator is unrelated; any other missing CLI
    // originator is plausible but unconfirmed and therefore a coverage issue.
    return originator === CODEX_DESKTOP_ORIGINATOR ? { kind: 'skip' } : ambiguous();
  }

  // A CLI originator under a non-CLI source is conflicting evidence. It could
  // be a newly introduced source spelling, so fail closed with coverage data.
  if (originator === CODEX_CLI_ORIGINATOR) return ambiguous();
  if (originator === CODEX_DESKTOP_ORIGINATOR) return { kind: 'skip' };
  if (CONFIDENTLY_UNRELATED_SOURCES.has(source)) return { kind: 'skip' };

  // Unknown/custom source values with no originator cannot be safely mapped to
  // a surface. Keep the issue fixed and metadata-free for diagnostics.
  return originator === undefined ? ambiguous() : { kind: 'skip' };
}

/** Qualify a complete catalog projection without retaining rejected records. */
export function qualifyCodexCliCatalog(
  records: readonly CodexCatalogRecord[],
  onIssue?: (issue: CodexCliQualificationIssue) => void,
): CodexCliCatalogQualification {
  const sessions: CodexCliQualificationSession[] = [];
  const issues: CodexCliQualificationIssue[] = [];
  for (const record of records) {
    const decision = qualifyCodexCliRecord(record);
    if (decision.kind === 'qualified') {
      sessions.push(decision.session);
    } else if (decision.kind === 'ambiguous') {
      issues.push(decision.issue);
      try {
        onIssue?.(decision.issue);
      } catch {
        // Issue sinks are advisory and must not affect qualification.
      }
    }
  }
  return { sessions, issues };
}

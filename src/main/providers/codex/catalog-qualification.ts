import type { CodexCatalogRecord } from './catalog-client';

/**
 * Qualification intentionally exposes a fixed issue vocabulary. In
 * particular, diagnostics never echo source metadata, paths, IDs, or titles.
 */
export type CodexQualificationIssueCode = 'coverage-ambiguous';

export interface CodexQualificationIssue {
  code: CodexQualificationIssueCode;
}

export interface CodexDesktopQualification {
  nativeId: string;
  sessionId: string;
  projectBasename: string;
  name?: string;
  rolloutPath?: string;
  createdAt: number;
  updatedAt: number;
  surface: 'desktop';
  isTopLevel: true;
  isArchived: boolean;
}

export type CodexQualificationDecision =
  | { kind: 'qualified'; session: CodexDesktopQualification }
  | { kind: 'needs-rollout-proof'; session: CodexDesktopQualification }
  | { kind: 'skip' }
  | { kind: 'ambiguous'; issue: CodexQualificationIssue };

export interface CodexDesktopCatalogQualification {
  sessions: readonly CodexDesktopQualification[];
  needsRolloutProof: readonly CodexDesktopQualification[];
  issues: readonly CodexQualificationIssue[];
}

const CODEX_DESKTOP_ORIGINATOR = 'Codex Desktop';
const CONFIDENTLY_UNRELATED_SOURCES = new Set([
  'cli',
  'exec',
  'appServer',
  'subAgentReview',
  'subAgentCompact',
  'subAgentMemoryConsolidation',
  'subAgentThreadSpawn',
  'subAgentOther',
]);

function ambiguous(): CodexQualificationDecision {
  return { kind: 'ambiguous', issue: { code: 'coverage-ambiguous' } };
}

/**
 * Qualify one metadata-only catalog record for the Codex Desktop surface.
 *
 * The source/originator pair is exact by design. A vscode record without a
 * catalog originator remains provisional until the monitor verifies the same
 * pair in the validated rollout SessionMeta. Other missing or contradictory
 * evidence remains a fixed coverage issue.
 */
export function qualifyCodexDesktopRecord(record: CodexCatalogRecord): CodexQualificationDecision {
  const source = record.sourceEvidence.source;
  const originator = record.sourceEvidence.originator;

  // These records are definitively not top-level Desktop sessions even when
  // another field happens to resemble Desktop metadata.
  if (
    record.isEphemeral ||
    record.sourceEvidence.isSubAgent ||
    record.parentThreadId !== undefined
  ) {
    return { kind: 'skip' };
  }

  if (source !== 'vscode') {
    if (originator === CODEX_DESKTOP_ORIGINATOR) return ambiguous();
    if (CONFIDENTLY_UNRELATED_SOURCES.has(source)) return { kind: 'skip' };
    // `unknown`, `custom`, and future source values cannot be used to infer a
    // surface. Missing evidence remains an explicit coverage issue; a known
    // non-Desktop originator is confidently unrelated.
    return originator === undefined || originator === CODEX_DESKTOP_ORIGINATOR
      ? ambiguous()
      : { kind: 'skip' };
  }
  if (originator === undefined) {
    return { kind: 'needs-rollout-proof', session: qualifiedSession(record) };
  }
  if (originator !== CODEX_DESKTOP_ORIGINATOR) return { kind: 'skip' };

  return { kind: 'qualified', session: qualifiedSession(record) };
}

function qualifiedSession(record: CodexCatalogRecord): CodexDesktopQualification {
  return {
    nativeId: record.nativeId,
    sessionId: record.sessionId,
    projectBasename: record.projectBasename,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.rolloutPath === undefined ? {} : { rolloutPath: record.rolloutPath }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    surface: 'desktop',
    isTopLevel: true,
    isArchived: record.isArchived ?? false,
  };
}

/** Qualify a complete catalog projection without retaining rejected records. */
export function qualifyCodexDesktopCatalog(
  records: readonly CodexCatalogRecord[],
  onIssue?: (issue: CodexQualificationIssue) => void,
): CodexDesktopCatalogQualification {
  const sessions: CodexDesktopQualification[] = [];
  const needsRolloutProof: CodexDesktopQualification[] = [];
  const issues: CodexQualificationIssue[] = [];
  for (const record of records) {
    const decision = qualifyCodexDesktopRecord(record);
    if (decision.kind === 'qualified') {
      sessions.push(decision.session);
    } else if (decision.kind === 'needs-rollout-proof') {
      needsRolloutProof.push(decision.session);
    } else if (decision.kind === 'ambiguous') {
      issues.push(decision.issue);
      try {
        onIssue?.(decision.issue);
      } catch {
        // Issue sinks are advisory and must not affect qualification.
      }
    }
  }
  return { sessions, needsRolloutProof, issues };
}

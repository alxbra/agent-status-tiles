import { describe, expect, it } from 'vitest';

import type { CodexCatalogRecord } from '../../src/main/providers/codex/catalog-client';
import {
  qualifyCodexCliCatalog,
  qualifyCodexCliRecord,
} from '../../src/main/providers/codex/cli-qualification';

function record(
  overrides: Partial<CodexCatalogRecord['sourceEvidence']> &
    Partial<
      Pick<CodexCatalogRecord, 'isEphemeral' | 'isArchived' | 'parentThreadId' | 'forkedFromId'>
    > = {},
): CodexCatalogRecord {
  const {
    isEphemeral = false,
    isArchived = false,
    parentThreadId,
    forkedFromId,
    ...source
  } = overrides;
  return {
    nativeId: 'native-1',
    sessionId: 'session-1',
    createdAt: 1,
    updatedAt: 2,
    isEphemeral,
    isArchived,
    projectBasename: 'project',
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(forkedFromId === undefined ? {} : { forkedFromId }),
    sourceEvidence: {
      source: 'cli',
      cliVersion: '0.1.0',
      isSubAgent: false,
      originator: 'codex_cli_rs',
      ...source,
    },
  };
}

describe('Codex CLI catalog qualification', () => {
  it('requires the exact CLI source/originator pair and preserves projection fields', () => {
    expect(
      qualifyCodexCliRecord({
        ...record({ isArchived: true }),
        rolloutPath: '/private/user/.codex/sessions/rollout.jsonl',
      }),
    ).toEqual({
      kind: 'qualified',
      session: {
        nativeId: 'native-1',
        sessionId: 'session-1',
        projectBasename: 'project',
        rolloutPath: '/private/user/.codex/sessions/rollout.jsonl',
        createdAt: 1,
        updatedAt: 2,
        surface: 'cli',
        isTopLevel: true,
        isArchived: true,
      },
    });
    expect(
      qualifyCodexCliRecord(record({ source: 'vscode', originator: 'Codex Desktop' })),
    ).toEqual({ kind: 'skip' });
  });

  it('skips known Desktop/subagent records and all non-top-level records', () => {
    for (const originator of ['Codex Desktop', 'codex_work_desktop']) {
      expect(qualifyCodexCliRecord(record({ source: 'vscode', originator }))).toEqual({
        kind: 'skip',
      });
    }
    expect(
      qualifyCodexCliRecord(record({ source: 'subAgentReview', originator: undefined })),
    ).toEqual({ kind: 'skip' });
    expect(qualifyCodexCliRecord(record({ isEphemeral: true }))).toEqual({ kind: 'skip' });
    expect(qualifyCodexCliRecord(record({ parentThreadId: 'parent' }))).toEqual({ kind: 'skip' });
    expect(qualifyCodexCliRecord(record({ forkedFromId: 'parent' }))).toMatchObject({
      kind: 'qualified',
    });
    expect(
      qualifyCodexCliRecord({
        ...record(),
        sourceEvidence: { ...record().sourceEvidence, isSubAgent: true },
      }),
    ).toEqual({ kind: 'skip' });
  });

  it('reports ambiguous CLI evidence with a fixed metadata-free issue', () => {
    const decisions = [
      qualifyCodexCliRecord(record({ originator: undefined })),
      qualifyCodexCliRecord(record({ originator: 'future_cli' })),
      qualifyCodexCliRecord(record({ source: 'unknown', originator: undefined })),
      qualifyCodexCliRecord(record({ source: 'custom', originator: undefined })),
      qualifyCodexCliRecord(record({ source: 'unknown', originator: 'codex_cli_rs' })),
    ];
    for (const decision of decisions) {
      expect(decision).toEqual({ kind: 'ambiguous', issue: { code: 'coverage-ambiguous' } });
      expect(JSON.stringify(decision)).not.toContain('session-1');
      expect(JSON.stringify(decision)).not.toContain('project');
    }
  });

  it('returns only qualified sessions and fixed issues', () => {
    const issues: string[] = [];
    const result = qualifyCodexCliCatalog(
      [
        record(),
        record({ originator: undefined }),
        record({ source: 'vscode', originator: 'Codex Desktop' }),
      ],
      (issue) => issues.push(issue.code),
    );
    expect(result.sessions).toHaveLength(1);
    expect(result.issues).toEqual([{ code: 'coverage-ambiguous' }]);
    expect(issues).toEqual(['coverage-ambiguous']);
  });
});

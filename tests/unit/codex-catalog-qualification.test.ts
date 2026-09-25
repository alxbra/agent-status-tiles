import { describe, expect, it } from 'vitest';

import {
  qualifyCodexDesktopCatalog,
  qualifyCodexDesktopRecord,
} from '../../src/main/providers/codex/catalog-qualification';
import type { CodexCatalogRecord } from '../../src/main/providers/codex/catalog-client';

function record(
  overrides: Partial<CodexCatalogRecord['sourceEvidence']> &
    Partial<Pick<CodexCatalogRecord, 'isEphemeral' | 'isArchived' | 'parentThreadId'>> = {},
): CodexCatalogRecord {
  const { isEphemeral = false, isArchived = false, parentThreadId, ...source } = overrides;
  return {
    nativeId: 'native-1',
    sessionId: 'session-1',
    createdAt: 1,
    updatedAt: 2,
    isEphemeral,
    isArchived,
    projectBasename: 'project',
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    sourceEvidence: {
      source: 'vscode',
      cliVersion: '0.1.0',
      isSubAgent: false,
      originator: 'Codex Desktop',
      ...source,
    },
  };
}

describe('Codex Desktop catalog qualification', () => {
  it('requires the exact source/originator pair and preserves archive state', () => {
    expect(qualifyCodexDesktopRecord(record({ isArchived: true }))).toEqual({
      kind: 'qualified',
      session: expect.objectContaining({
        surface: 'desktop',
        isTopLevel: true,
        isArchived: true,
      }),
    });
    expect(
      qualifyCodexDesktopRecord(record({ source: 'cli', originator: 'codex_cli_rs' })),
    ).toEqual({ kind: 'skip' });
    expect(qualifyCodexDesktopRecord(record({ originator: 'Other Editor' }))).toEqual({
      kind: 'skip',
    });
  });

  it('accepts the originator newer Codex Desktop builds write', () => {
    expect(qualifyCodexDesktopRecord(record({ originator: 'codex_work_desktop' }))).toEqual({
      kind: 'qualified',
      session: expect.objectContaining({ nativeId: 'native-1', surface: 'desktop' }),
    });
    // The new spelling under a non-Desktop source is contradictory, as before.
    expect(
      qualifyCodexDesktopRecord(record({ source: 'cli', originator: 'codex_work_desktop' })),
    ).toEqual({ kind: 'ambiguous', issue: { code: 'coverage-ambiguous' } });
    // Only exact spellings count.
    for (const originator of ['Codex_Work_Desktop', 'codex_work_desktop ', 'codex_desktop']) {
      expect(qualifyCodexDesktopRecord(record({ originator }))).toEqual({ kind: 'skip' });
    }
  });

  it('requires rollout proof when a vscode catalog record lacks an originator', () => {
    expect(qualifyCodexDesktopRecord(record({ originator: undefined }))).toEqual({
      kind: 'needs-rollout-proof',
      session: expect.objectContaining({ nativeId: 'native-1', surface: 'desktop' }),
    });
  });

  it('reports other ambiguous evidence without echoing metadata', () => {
    const decisions = [
      qualifyCodexDesktopRecord(record({ source: 'unknown', originator: undefined })),
      qualifyCodexDesktopRecord(record({ source: 'custom', originator: 'Codex Desktop' })),
      qualifyCodexDesktopRecord(record({ source: 'cli', originator: 'Codex Desktop' })),
    ];
    for (const decision of decisions) {
      expect(decision).toEqual({ kind: 'ambiguous', issue: { code: 'coverage-ambiguous' } });
      expect(JSON.stringify(decision)).not.toContain('session-1');
      expect(JSON.stringify(decision)).not.toContain('project');
    }
  });

  it('never promotes children or ephemeral records', () => {
    expect(qualifyCodexDesktopRecord(record({ isEphemeral: true }))).toEqual({ kind: 'skip' });
    expect(qualifyCodexDesktopRecord(record({ parentThreadId: 'parent' }))).toEqual({
      kind: 'skip',
    });
  });

  it('returns only qualified sessions and fixed issues', () => {
    const issues: string[] = [];
    const result = qualifyCodexDesktopCatalog(
      [
        record(),
        record({ originator: undefined }),
        record({ source: 'cli', originator: 'codex_cli_rs' }),
      ],
      (issue) => issues.push(issue.code),
    );
    expect(result.sessions).toHaveLength(1);
    expect(result.needsRolloutProof).toHaveLength(1);
    expect(result.issues).toEqual([]);
    expect(issues).toEqual([]);
  });
});

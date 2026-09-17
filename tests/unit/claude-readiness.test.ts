import { describe, expect, it } from 'vitest';

import { claudeIssueSentence, readinessOf } from '../../src/main/providers/claude/readiness';

describe('claude readiness', () => {
  it('maps helper and hook verification states onto one issue each', () => {
    const helper = {
      ok: true as const,
      path: '/Applications/A.app/Contents/Resources/hook-helper/arm64/hook-helper',
    };
    expect(readinessOf(helper, { status: 'installed' })).toEqual({ status: 'ready' });
    expect(readinessOf(helper, { status: 'missing' })).toEqual({
      status: 'issue',
      issue: 'hooks-missing',
    });
    expect(readinessOf(helper, { status: 'stale' })).toEqual({
      status: 'issue',
      issue: 'hooks-missing',
    });
    expect(readinessOf(helper, { status: 'disabled' })).toEqual({
      status: 'issue',
      issue: 'hooks-disabled',
    });
    expect(readinessOf(helper, { status: 'unreadable', code: 'settings-not-json' })).toEqual({
      status: 'issue',
      issue: 'settings-unreadable',
    });
    // A missing helper beats everything: hooks pointing nowhere cannot help.
    expect(readinessOf({ ok: false, code: 'helper-missing' }, { status: 'installed' })).toEqual({
      status: 'issue',
      issue: 'helper-missing',
    });
  });

  it('phrases every issue as one actionable sentence without paths', () => {
    for (const issue of [
      'helper-missing',
      'hooks-missing',
      'hooks-disabled',
      'settings-unreadable',
    ] as const) {
      const sentence = claudeIssueSentence(issue);
      expect(sentence).toMatch(/Repair/u);
      expect(sentence).not.toMatch(/\//u);
      expect(sentence.length).toBeLessThan(160);
    }
  });
});

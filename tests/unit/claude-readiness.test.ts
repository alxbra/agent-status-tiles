import { describe, expect, it } from 'vitest';

import { ClaudeHookSettingsError } from '../../src/main/providers/claude/hook-installer';
import {
  ClaudeHelperError,
  claudeActionFailureSentence,
  claudeIssueSentence,
  readinessOf,
} from '../../src/main/providers/claude/readiness';

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
    expect(
      readinessOf({ ok: false, code: 'helper-translocated' }, { status: 'installed' }),
    ).toEqual({ status: 'issue', issue: 'helper-translocated' });
    for (const code of [
      'unsupported-architecture',
      'helper-not-regular',
      'helper-not-executable',
      'resolver-failed',
    ] as const) {
      expect(readinessOf({ ok: false, code }, { status: 'installed' })).toEqual({
        status: 'issue',
        issue: 'helper-unusable',
      });
    }
  });

  it('turns a known action failure into a sentence naming an action the row offers', () => {
    const changed = new ClaudeHookSettingsError('settings-changed');
    expect(claudeActionFailureSentence(changed, 'connect')).toBe(
      'Claude Code settings changed during the update. Connect again.',
    );
    expect(claudeActionFailureSentence(changed, 'repair')).toBe(
      'Claude Code settings changed during the update. Use Repair.',
    );
    expect(claudeActionFailureSentence(changed, 'disconnect')).toBe(
      "Claude Code settings changed during the update, so this app's hooks remain. Connect and disconnect again.",
    );
    expect(
      claudeActionFailureSentence(new ClaudeHookSettingsError('settings-not-json'), 'connect'),
    ).toBe(
      'The Claude Code settings file could not be read or updated. Fix it, then connect again.',
    );
    expect(
      claudeActionFailureSentence(
        new ClaudeHelperError({ ok: false, code: 'helper-translocated' }),
        'connect',
      ),
    ).toBe('Move Agent Status Tiles to the Applications folder and reopen it, then connect again.');
    expect(claudeActionFailureSentence(new Error('checkpoint failed'), 'connect')).toBeUndefined();
  });

  it('phrases every issue as one actionable sentence without paths', () => {
    for (const issue of [
      'helper-missing',
      'helper-translocated',
      'helper-unusable',
      'hooks-missing',
      'hooks-disabled',
      'settings-unreadable',
    ] as const) {
      const sentence = claudeIssueSentence(issue);
      expect(sentence).not.toMatch(/\//u);
      expect(sentence.length).toBeLessThan(160);
    }
    // Every issue except a disabled install points at Repair; that one resumes by itself.
    expect(claudeIssueSentence('hooks-disabled')).not.toMatch(/Repair/u);
    expect(claudeIssueSentence('hooks-missing')).toMatch(/Repair/u);
  });
});

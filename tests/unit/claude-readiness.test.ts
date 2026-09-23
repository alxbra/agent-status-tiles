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
    // A managed restriction outranks the user file: no install or Repair changes it.
    const restricted = { status: 'restricted' as const, setting: 'allowManagedHooksOnly' as const };
    for (const verification of [
      { status: 'installed' as const },
      { status: 'missing' as const },
      { status: 'unreadable' as const, code: 'settings-not-json' as const },
    ]) {
      expect(readinessOf(helper, verification, restricted)).toEqual({
        status: 'issue',
        issue: 'hooks-blocked',
      });
    }
    // A managed tier that could not be read never alarms.
    expect(readinessOf(helper, { status: 'installed' }, { status: 'unknown' })).toEqual({
      status: 'ready',
    });
    expect(readinessOf(helper, { status: 'missing' }, { status: 'unrestricted' })).toEqual({
      status: 'issue',
      issue: 'hooks-missing',
    });
    // A missing helper beats everything: hooks pointing nowhere cannot help.
    expect(readinessOf({ ok: false, code: 'helper-missing' }, { status: 'installed' })).toEqual({
      status: 'issue',
      issue: 'helper-missing',
    });
    expect(
      readinessOf({ ok: false, code: 'helper-missing' }, { status: 'installed' }, restricted),
    ).toEqual({ status: 'issue', issue: 'helper-missing' });
    expect(
      readinessOf({ ok: false, code: 'helper-translocated' }, { status: 'installed' }),
    ).toEqual({ status: 'issue', issue: 'helper-translocated' });
    expect(readinessOf({ ok: false, code: 'helper-not-built' }, { status: 'installed' })).toEqual({
      status: 'issue',
      issue: 'helper-not-built',
    });
    expect(claudeIssueSentence('helper-not-built', 'connect')).toBe(
      'The hook helper is not built in this checkout. Run pnpm build:hook-helper -- --arch host, then connect again.',
    );
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
      'helper-not-built',
      'helper-translocated',
      'helper-unusable',
      'hooks-missing',
      'hooks-disabled',
      'hooks-blocked',
      'settings-unreadable',
    ] as const) {
      const sentence = claudeIssueSentence(issue);
      expect(sentence).not.toMatch(/\//u);
      expect(sentence.length).toBeLessThan(160);
    }
    // A disabled or policy-blocked install never points at Repair; both resume by themselves.
    expect(claudeIssueSentence('hooks-disabled')).not.toMatch(/Repair/u);
    expect(claudeIssueSentence('hooks-blocked')).not.toMatch(/Repair/u);
    expect(claudeIssueSentence('hooks-blocked')).toMatch(/administrator/u);
    expect(claudeIssueSentence('hooks-missing')).toMatch(/Repair/u);
  });
});

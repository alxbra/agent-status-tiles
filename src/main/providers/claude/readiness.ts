import type { HookHelperPathResolution } from './helper-path';
import type { ClaudeHookVerification } from './hook-installer';

/** Why a Claude surface cannot observe sessions; each maps to one Settings sentence. */
export type ClaudeIssue =
  'helper-missing' | 'hooks-missing' | 'hooks-disabled' | 'settings-unreadable';

export type ClaudeReadiness = { status: 'ready' } | { status: 'issue'; issue: ClaudeIssue };

/**
 * Combine the bundled helper resolution and the settings-file verification
 * into one answer. A stale install counts as missing: the entries exist but
 * do not point at this app's helper, so callbacks never reach it.
 */
export function readinessOf(
  helper: HookHelperPathResolution,
  verification: ClaudeHookVerification,
): ClaudeReadiness {
  if (!helper.ok) return { status: 'issue', issue: 'helper-missing' };
  switch (verification.status) {
    case 'installed':
      return { status: 'ready' };
    case 'missing':
    case 'stale':
      return { status: 'issue', issue: 'hooks-missing' };
    case 'disabled':
      return { status: 'issue', issue: 'hooks-disabled' };
    case 'unreadable':
      return { status: 'issue', issue: 'settings-unreadable' };
  }
}

/** One actionable sentence per issue; never a path or file content. */
export function claudeIssueSentence(issue: ClaudeIssue): string {
  switch (issue) {
    case 'helper-missing':
      return 'The hook helper is missing from this app. Reinstall Agent Status Tiles, then use Repair.';
    case 'hooks-missing':
      return 'Claude Code hooks are not installed. Use Repair to install them.';
    case 'hooks-disabled':
      return 'Claude Code hooks are disabled by disableAllHooks in its settings. Enable hooks, then use Repair.';
    case 'settings-unreadable':
      return 'The Claude Code settings file could not be read or updated. Fix it, then use Repair.';
  }
}

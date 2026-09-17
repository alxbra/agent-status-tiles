import type { HookHelperPathResolution } from './helper-path';
import { ClaudeHookSettingsError, type ClaudeHookVerification } from './hook-installer';

/** Why a Claude surface cannot observe sessions; each maps to one Settings sentence. */
export type ClaudeIssue =
  | 'helper-missing'
  | 'helper-translocated'
  | 'helper-unusable'
  | 'hooks-missing'
  | 'hooks-disabled'
  | 'settings-unreadable';

export type ClaudeReadiness = { status: 'ready' } | { status: 'issue'; issue: ClaudeIssue };

function helperIssue(helper: HookHelperPathResolution): ClaudeIssue | undefined {
  if (helper.ok) return undefined;
  switch (helper.code) {
    case 'helper-missing':
      return 'helper-missing';
    case 'helper-translocated':
      return 'helper-translocated';
    case 'unsupported-architecture':
    case 'helper-not-regular':
    case 'helper-not-executable':
    case 'resolver-failed':
      return 'helper-unusable';
  }
}

/**
 * Combine the bundled helper resolution and the settings-file verification
 * into one answer. A stale install counts as missing: the entries exist but
 * do not point at this app's helper, so callbacks never reach it.
 */
export function readinessOf(
  helper: HookHelperPathResolution,
  verification: ClaudeHookVerification,
): ClaudeReadiness {
  const issue = helperIssue(helper);
  if (issue !== undefined) return { status: 'issue', issue };
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
    case 'helper-translocated':
      return 'Move Agent Status Tiles to the Applications folder and reopen it, then use Repair.';
    case 'helper-unusable':
      return 'The bundled hook helper cannot run on this Mac. Reinstall Agent Status Tiles, then use Repair.';
    case 'hooks-missing':
      return 'Claude Code hooks are not installed. Use Repair to install them.';
    case 'hooks-disabled':
      return 'Remove disableAllHooks from Claude Code settings; the connection resumes on its own.';
    case 'settings-unreadable':
      return 'The Claude Code settings file could not be read. Fix it, then use Repair.';
  }
}

/**
 * The sentence for a Connect or Repair that failed while installing the
 * hooks; anything not recognised is left to the generic retry text.
 */
export function claudeInstallFailureSentence(error: unknown): string | undefined {
  if (error instanceof ClaudeHookSettingsError) {
    return error.code === 'settings-changed'
      ? 'Claude Code settings changed while connecting. Connect again.'
      : 'The Claude Code settings file could not be read or updated. Fix it, then connect again.';
  }
  if (error instanceof ClaudeHelperError) return claudeIssueSentence(error.issue);
  return undefined;
}

/** Thrown by the Claude setup when the bundled helper cannot be installed. */
export class ClaudeHelperError extends Error {
  readonly issue: ClaudeIssue;

  constructor(helper: HookHelperPathResolution) {
    const issue = helperIssue(helper) ?? 'helper-unusable';
    super(`claude-${issue}`);
    this.name = 'ClaudeHelperError';
    this.issue = issue;
  }
}

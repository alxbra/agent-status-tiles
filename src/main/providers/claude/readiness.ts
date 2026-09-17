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

/** The Settings action a sentence can send the user to, given the row's state. */
export type ClaudeAction = 'connect' | 'repair' | 'disconnect';

type HelperFailure = Extract<HookHelperPathResolution, { ok: false }>;

function helperIssue(helper: HelperFailure): ClaudeIssue {
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

/** The readiness a failed helper resolution implies, before any settings file is read. */
export function helperReadiness(helper: HookHelperPathResolution): ClaudeReadiness | undefined {
  return helper.ok ? undefined : { status: 'issue', issue: helperIssue(helper) };
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
  const fromHelper = helperReadiness(helper);
  if (fromHelper !== undefined) return fromHelper;
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

function nextStep(action: ClaudeAction): string {
  switch (action) {
    case 'connect':
      return 'connect again';
    case 'repair':
      return 'use Repair';
    case 'disconnect':
      return 'connect and disconnect again';
  }
}

/**
 * One actionable sentence per issue; never a path or file content. The
 * closing step names an action the row offers in its current state: Repair
 * on a connected row, Connect on a disconnected one.
 */
export function claudeIssueSentence(issue: ClaudeIssue, action: ClaudeAction = 'repair'): string {
  const step = nextStep(action);
  switch (issue) {
    case 'helper-missing':
      return `The hook helper is missing from this app. Reinstall Agent Status Tiles, then ${step}.`;
    case 'helper-translocated':
      return `Move Agent Status Tiles to the Applications folder and reopen it, then ${step}.`;
    case 'helper-unusable':
      return `The bundled hook helper cannot run on this Mac. Reinstall Agent Status Tiles, then ${step}.`;
    case 'hooks-missing':
      return 'Claude Code hooks are not installed. Use Repair to install them.';
    case 'hooks-disabled':
      return 'Remove disableAllHooks from Claude Code settings; the connection resumes on its own.';
    case 'settings-unreadable':
      return `The Claude Code settings file could not be read. Fix it, then ${step}.`;
  }
}

/**
 * The sentence for a Connect, Repair, or Disconnect that failed for a known
 * reason while installing or removing the hooks; anything not recognised is
 * left to the generic retry text. After a failed removal the hooks remain,
 * and only a fresh Connect followed by Disconnect can clear them.
 */
export function claudeActionFailureSentence(
  error: unknown,
  action: ClaudeAction,
): string | undefined {
  const step = nextStep(action);
  if (error instanceof ClaudeHookSettingsError) {
    const remain = action === 'disconnect' ? ", so this app's hooks remain" : '';
    return error.code === 'settings-changed'
      ? `Claude Code settings changed during the update${remain}. ${step[0]!.toUpperCase()}${step.slice(1)}.`
      : `The Claude Code settings file could not be read or updated${remain}. Fix it, then ${step}.`;
  }
  if (error instanceof ClaudeHelperError) return claudeIssueSentence(error.issue, action);
  return undefined;
}

/** Thrown by the Claude setup when the bundled helper cannot be installed. */
export class ClaudeHelperError extends Error {
  readonly issue: ClaudeIssue;

  constructor(helper: HelperFailure) {
    const issue = helperIssue(helper);
    super(`claude-${issue}`);
    this.name = 'ClaudeHelperError';
    this.issue = issue;
  }
}

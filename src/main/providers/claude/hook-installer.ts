import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** Every lifecycle event the helper accepts; see `docs/hook-helper.md`. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'Elicitation',
  'ElicitationResult',
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

/** The helper finishes in well under a second; the cap only bounds a wedged disk. */
export const CLAUDE_HOOK_TIMEOUT_SECONDS = 5;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const HELPER_BASENAME = 'hook-helper';

export type ClaudeHookVerification =
  /** Every event carries exactly one owned hook pointing at the current helper. */
  | { status: 'installed' }
  /** No owned hooks at all, including a missing settings file. */
  | { status: 'missing' }
  /** Owned hooks exist but some are absent or point at another helper or data directory. */
  | { status: 'stale' }
  /** Owned hooks exist but `disableAllHooks` silences them. */
  | { status: 'disabled' }
  | { status: 'unreadable'; code: ClaudeHookSettingsCode };

export type ClaudeHookSettingsCode =
  | 'settings-unreadable'
  | 'settings-not-json'
  | 'settings-not-object'
  | 'settings-oversized'
  | 'hooks-unsupported';

export class ClaudeHookSettingsError extends Error {
  readonly code: ClaudeHookSettingsCode;

  constructor(code: ClaudeHookSettingsCode) {
    super(code);
    this.name = 'ClaudeHookSettingsError';
    this.code = code;
  }
}

export interface ClaudeHookInstallerOptions {
  /** Claude's configuration directory; `~/.claude` unless the user relocated it. */
  configDirectory?: string;
  /** Absolute path of the bundled helper executable. */
  helperPath: string;
  /** Absolute private app-data directory the helper journals into. */
  dataDirectory: string;
}

export interface ClaudeHookChange {
  /** False when the file already held exactly the intended entries. */
  changed: boolean;
}

interface OwnedHookCommand {
  helperPath: string;
  dataDirectory: string;
}

type JsonObject = Record<string, unknown>;

export function defaultClaudeConfigDirectory(): string {
  return join(homedir(), '.claude');
}

export function claudeSettingsPath(configDirectory = defaultClaudeConfigDirectory()): string {
  return join(configDirectory, 'settings.json');
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * The hook command Claude Code runs through a shell. Both paths are quoted so
 * an application folder with spaces works, and the fixed argument order is
 * what marks the entry as owned by this app.
 */
export function formatOwnedHookCommand(command: OwnedHookCommand): string {
  return `${quoteForShell(command.helperPath)} --provider claude --data-dir ${quoteForShell(command.dataDirectory)}`;
}

const OWNED_COMMAND_PATTERN =
  /^'((?:[^']|'\\'')*)' --provider claude --data-dir '((?:[^']|'\\'')*)'$/u;

function unquote(value: string): string {
  return value.replace(/'\\''/gu, `'`);
}

/** Recognise an entry this app wrote; anything else in the file is never touched. */
export function parseOwnedHookCommand(command: unknown): OwnedHookCommand | undefined {
  if (typeof command !== 'string') return undefined;
  const match = OWNED_COMMAND_PATTERN.exec(command);
  if (match === null) return undefined;
  const helperPath = unquote(match[1] ?? '');
  const dataDirectory = unquote(match[2] ?? '');
  if (!isAbsolute(helperPath) || !isAbsolute(dataDirectory)) return undefined;
  if (helperPath.split('/').at(-1) !== HELPER_BASENAME) return undefined;
  return { helperPath, dataDirectory };
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownedHookEntry(command: OwnedHookCommand): JsonObject {
  return {
    type: 'command',
    command: formatOwnedHookCommand(command),
    timeout: CLAUDE_HOOK_TIMEOUT_SECONDS,
    async: true,
  };
}

function isOwnedHook(hook: unknown): boolean {
  return isRecord(hook) && parseOwnedHookCommand(hook.command) !== undefined;
}

function ownedCommandOf(hook: unknown): OwnedHookCommand | undefined {
  return isRecord(hook) ? parseOwnedHookCommand(hook.command) : undefined;
}

/** A matcher group is `{ matcher?, hooks: [...] }`; anything else is left untouched. */
function isMatcherGroup(group: unknown): group is JsonObject & { hooks: unknown[] } {
  return isRecord(group) && Array.isArray(group.hooks);
}

function readHooksSection(settings: JsonObject): JsonObject {
  const hooks = settings.hooks;
  if (hooks === undefined) return {};
  if (!isRecord(hooks)) throw new ClaudeHookSettingsError('hooks-unsupported');
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) throw new ClaudeHookSettingsError('hooks-unsupported');
  }
  return hooks;
}

/** Drop owned hooks from one event's matcher groups, removing groups that become empty. */
function withoutOwnedHooks(groups: readonly unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const group of groups) {
    if (!isMatcherGroup(group)) {
      result.push(group);
      continue;
    }
    const remaining = group.hooks.filter((hook) => !isOwnedHook(hook));
    if (remaining.length === group.hooks.length) {
      result.push(group);
    } else if (remaining.length > 0) {
      result.push({ ...group, hooks: remaining });
    }
  }
  return result;
}

/**
 * Return the settings object with exactly one owned entry per event, keeping
 * every unrelated key, event, matcher group, and hook in place and in order.
 */
export function planClaudeHookInstall(settings: JsonObject, command: OwnedHookCommand): JsonObject {
  const hooks = readHooksSection(settings);
  const nextHooks: JsonObject = { ...hooks };
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    nextHooks[event] = [...withoutOwnedHooks(groups), { hooks: [ownedHookEntry(command)] }];
  }
  return { ...settings, hooks: nextHooks };
}

/** Return the settings object with every owned entry removed and empty containers dropped. */
export function planClaudeHookRemoval(settings: JsonObject): JsonObject {
  const hooks = readHooksSection(settings);
  const nextHooks: JsonObject = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const remaining = withoutOwnedHooks(groups as unknown[]);
    if (remaining.length > 0) nextHooks[event] = remaining;
  }
  const rest: JsonObject = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key !== 'hooks') rest[key] = value;
  }
  return Object.keys(nextHooks).length === 0 ? rest : { ...rest, hooks: nextHooks };
}

/** Compare the file's owned entries against the intended command without writing. */
export function verifyClaudeHooks(
  settings: JsonObject,
  command: OwnedHookCommand,
): ClaudeHookVerification {
  let hooks: JsonObject;
  try {
    hooks = readHooksSection(settings);
  } catch (error) {
    if (error instanceof ClaudeHookSettingsError) return { status: 'unreadable', code: error.code };
    throw error;
  }
  const expected = formatOwnedHookCommand(command);
  let ownedCount = 0;
  let currentCount = 0;
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const owned = groups
      .filter(isMatcherGroup)
      .flatMap((group) => group.hooks.map(ownedCommandOf))
      .filter((value): value is OwnedHookCommand => value !== undefined);
    ownedCount += owned.length;
    if (owned.length === 1 && formatOwnedHookCommand(owned[0]!) === expected) currentCount += 1;
  }
  if (ownedCount === 0) return { status: 'missing' };
  if (currentCount !== CLAUDE_HOOK_EVENTS.length || ownedCount !== CLAUDE_HOOK_EVENTS.length) {
    return { status: 'stale' };
  }
  if (settings.disableAllHooks === true) return { status: 'disabled' };
  return { status: 'installed' };
}

async function readSettingsFile(path: string): Promise<{ settings: JsonObject; exists: boolean }> {
  let raw: string;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new ClaudeHookSettingsError('settings-unreadable');
    if (metadata.size > MAX_SETTINGS_BYTES) throw new ClaudeHookSettingsError('settings-oversized');
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof ClaudeHookSettingsError) throw error;
    if ((error as { code?: unknown }).code === 'ENOENT') return { settings: {}, exists: false };
    throw new ClaudeHookSettingsError('settings-unreadable');
  }
  if (raw.trim().length === 0) return { settings: {}, exists: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeHookSettingsError('settings-not-json');
  }
  if (!isRecord(parsed)) throw new ClaudeHookSettingsError('settings-not-object');
  return { settings: parsed, exists: true };
}

/**
 * Write through a symlinked settings file (dotfile setups) rather than
 * replacing the link, and land the new content with a rename so a crash never
 * leaves a truncated file behind.
 */
async function writeSettingsFile(path: string, settings: JsonObject): Promise<void> {
  let target = path;
  let mode = 0o600;
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink()) target = await realpath(path);
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') {
      throw new ClaudeHookSettingsError('settings-unreadable');
    }
    await mkdir(dirname(target), { mode: 0o700, recursive: true });
  }
  const payload = `${JSON.stringify(settings, null, 2)}\n`;
  const temporaryPath = join(dirname(target), `.settings.json.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', mode);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, target);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function commandFor(options: ClaudeHookInstallerOptions): OwnedHookCommand {
  if (!isAbsolute(options.helperPath) || !isAbsolute(options.dataDirectory)) {
    throw new Error('Hook helper and data directory paths must be absolute');
  }
  return { helperPath: options.helperPath, dataDirectory: options.dataDirectory };
}

/** Install or refresh the owned hooks; a file that already matches is left untouched. */
export async function installClaudeHooks(
  options: ClaudeHookInstallerOptions,
): Promise<ClaudeHookChange> {
  const command = commandFor(options);
  const path = claudeSettingsPath(options.configDirectory);
  const { settings } = await readSettingsFile(path);
  if (verifyClaudeHooks(settings, command).status === 'installed') return { changed: false };
  await writeSettingsFile(path, planClaudeHookInstall(settings, command));
  return { changed: true };
}

/** Remove only the owned hooks; a file without any is left untouched. */
export async function removeClaudeHooks(
  options: Pick<ClaudeHookInstallerOptions, 'configDirectory'>,
): Promise<ClaudeHookChange> {
  const path = claudeSettingsPath(options.configDirectory);
  const { settings, exists } = await readSettingsFile(path);
  if (!exists) return { changed: false };
  const next = planClaudeHookRemoval(settings);
  if (JSON.stringify(next) === JSON.stringify(settings)) return { changed: false };
  await writeSettingsFile(path, next);
  return { changed: true };
}

/** Report the owned-hook state of the settings file without writing. */
export async function inspectClaudeHooks(
  options: ClaudeHookInstallerOptions,
): Promise<ClaudeHookVerification> {
  const command = commandFor(options);
  try {
    const { settings } = await readSettingsFile(claudeSettingsPath(options.configDirectory));
    return verifyClaudeHooks(settings, command);
  } catch (error) {
    if (error instanceof ClaudeHookSettingsError) return { status: 'unreadable', code: error.code };
    throw error;
  }
}

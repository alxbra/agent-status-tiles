import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

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

/** The helper finishes in well under a second; the cap only bounds a wedged disk. */
export const CLAUDE_HOOK_TIMEOUT_SECONDS = 5;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const HELPER_BASENAME = 'hook-helper';

export type ClaudeHookVerification =
  /** Every event carries exactly one owned hook with the exact current shape. */
  | { status: 'installed' }
  /** No owned hooks at all, including a missing settings file. */
  | { status: 'missing' }
  /** Owned hooks exist but some are absent, duplicated, matcher-scoped, or differ from the current shape. */
  | { status: 'stale' }
  /** Owned hooks are complete but `disableAllHooks` silences them. */
  | { status: 'disabled' }
  | { status: 'unreadable'; code: ClaudeHookReadCode };

/** Why the settings file could not be read or understood. */
export type ClaudeHookReadCode =
  | 'settings-unreadable'
  | 'settings-not-json'
  | 'settings-not-object'
  | 'settings-oversized'
  | 'hooks-unsupported';

export type ClaudeHookSettingsCode =
  | ClaudeHookReadCode
  /** The file changed between the read and the write; nothing was written. */
  | 'settings-changed'
  | 'settings-unwritable';

const READ_CODES: ReadonlySet<ClaudeHookSettingsCode> = new Set<ClaudeHookReadCode>([
  'settings-unreadable',
  'settings-not-json',
  'settings-not-object',
  'settings-oversized',
  'hooks-unsupported',
]);

function isReadCode(code: ClaudeHookSettingsCode): code is ClaudeHookReadCode {
  return READ_CODES.has(code);
}

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
  /** False when the file already held exactly the intended content. */
  changed: boolean;
}

interface OwnedHookCommand {
  helperPath: string;
  dataDirectory: string;
}

type JsonObject = Record<string, unknown>;

/** Identity of the file version a plan was computed from. */
export interface SettingsSnapshot {
  target: string;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  /** Changes on chmod and ownership changes too, which mtime does not reflect. */
  ctimeNs: bigint;
  mode: number;
}

export interface SettingsRead {
  settings: JsonObject;
  /** Undefined when no file exists at the path. */
  snapshot: SettingsSnapshot | undefined;
}

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
  if (basename(helperPath) !== HELPER_BASENAME) return undefined;
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

/** True only for the exact entry `ownedHookEntry` writes: same keys, same values. */
function isCurrentOwnedEntry(hook: unknown, expected: JsonObject): boolean {
  if (!isRecord(hook)) return false;
  const keys = Object.keys(hook);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => Object.hasOwn(expected, key) && hook[key] === expected[key])
  );
}

/** A matcher group is `{ matcher?, hooks: [...] }`; anything else is left untouched. */
function isMatcherGroup(group: unknown): group is JsonObject & { hooks: unknown[] } {
  return isRecord(group) && Array.isArray(group.hooks);
}

function readHooksSection(settings: JsonObject): Record<string, unknown[]> {
  const hooks = settings.hooks;
  if (hooks === undefined) return {};
  if (!isRecord(hooks)) throw new ClaudeHookSettingsError('hooks-unsupported');
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) throw new ClaudeHookSettingsError('hooks-unsupported');
  }
  return hooks as Record<string, unknown[]>;
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
    const groups = hooks[event] ?? [];
    nextHooks[event] = [...withoutOwnedHooks(groups), { hooks: [ownedHookEntry(command)] }];
  }
  // Spread keeps an existing `hooks` key in place and appends a new one; it
  // also copies a user's literal "__proto__" key as data, which assignment
  // would not.
  return { ...settings, hooks: nextHooks };
}

/** Return the settings object with every owned entry removed and empty containers dropped. */
export function planClaudeHookRemoval(settings: JsonObject): JsonObject {
  const hooks = readHooksSection(settings);
  const nextHooks = Object.fromEntries(
    Object.entries(hooks)
      .map(([event, groups]) => [event, withoutOwnedHooks(groups)] as const)
      .filter(([, remaining]) => remaining.length > 0),
  );
  if (Object.keys(nextHooks).length > 0) return { ...settings, hooks: nextHooks };
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'hooks'));
}

/** Compare the file's owned entries against the intended entry without writing. */
export function verifyClaudeHooks(
  settings: JsonObject,
  command: OwnedHookCommand,
): ClaudeHookVerification {
  let hooks: Record<string, unknown[]>;
  try {
    hooks = readHooksSection(settings);
  } catch (error) {
    if (error instanceof ClaudeHookSettingsError && isReadCode(error.code)) {
      return { status: 'unreadable', code: error.code };
    }
    throw error;
  }
  const expected = ownedHookEntry(command);
  let ownedCount = 0;
  let currentEvents = 0;
  for (const event of CLAUDE_HOOK_EVENTS) {
    let ownedInEvent = 0;
    let currentInEvent = 0;
    for (const group of (hooks[event] ?? []).filter(isMatcherGroup)) {
      for (const hook of group.hooks) {
        if (!isOwnedHook(hook)) continue;
        ownedInEvent += 1;
        // A matcher would filter callbacks and any other field (a sync hook,
        // a different timeout) changes behaviour, so only the exact written
        // shape in a matcher-less group counts as current.
        if (!Object.hasOwn(group, 'matcher') && isCurrentOwnedEntry(hook, expected)) {
          currentInEvent += 1;
        }
      }
    }
    ownedCount += ownedInEvent;
    if (ownedInEvent === 1 && currentInEvent === 1) currentEvents += 1;
  }
  if (ownedCount === 0) return { status: 'missing' };
  if (currentEvents !== CLAUDE_HOOK_EVENTS.length || ownedCount !== CLAUDE_HOOK_EVENTS.length) {
    return { status: 'stale' };
  }
  if (settings.disableAllHooks === true) return { status: 'disabled' };
  return { status: 'installed' };
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

function snapshotOf(target: string, metadata: BigIntStats): SettingsSnapshot {
  if (!metadata.isFile()) throw new ClaudeHookSettingsError('settings-unreadable');
  return {
    target,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    mode: Number(metadata.mode & 0o777n),
  };
}

/**
 * Resolve the file behind the settings path. A symlink (dotfile setups) is
 * followed so writes go through it; a dangling link is the user's to repair
 * and is reported as unreadable, never replaced. Undefined means no entry.
 */
async function resolveSettingsTarget(path: string): Promise<string | undefined> {
  let link: Awaited<ReturnType<typeof lstat>>;
  try {
    link = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new ClaudeHookSettingsError('settings-unreadable');
  }
  if (!link.isSymbolicLink()) return path;
  try {
    return await realpath(path);
  } catch {
    throw new ClaudeHookSettingsError('settings-unreadable');
  }
}

/** Identity of the current file for the pre-rename check; undefined means no entry. */
async function currentSnapshot(path: string): Promise<SettingsSnapshot | undefined> {
  const target = await resolveSettingsTarget(path);
  if (target === undefined) return undefined;
  try {
    return snapshotOf(target, await stat(target, { bigint: true }));
  } catch (error) {
    if (error instanceof ClaudeHookSettingsError) throw error;
    throw new ClaudeHookSettingsError('settings-unreadable');
  }
}

/**
 * Read a Claude settings file (the user file, or a managed file) through one
 * descriptor so the snapshot describes exactly the bytes that were read, and
 * read at most the bound plus one byte so an oversized file is rejected
 * without being consumed. A missing file reads as an empty object with no
 * snapshot; anything else that cannot be read or understood throws a
 * `ClaudeHookSettingsError` with one of the read codes.
 */
export async function readClaudeSettingsFile(path: string): Promise<SettingsRead> {
  const target = await resolveSettingsTarget(path);
  if (target === undefined) return { settings: {}, snapshot: undefined };
  let snapshot: SettingsSnapshot;
  let raw: string;
  try {
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      snapshot = snapshotOf(target, await handle.stat({ bigint: true }));
      const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_SETTINGS_BYTES) throw new ClaudeHookSettingsError('settings-oversized');
      raw = buffer.toString('utf8', 0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ClaudeHookSettingsError) throw error;
    throw new ClaudeHookSettingsError('settings-unreadable');
  }
  if (raw.trim().length === 0) return { settings: {}, snapshot };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeHookSettingsError('settings-not-json');
  }
  if (!isRecord(parsed)) throw new ClaudeHookSettingsError('settings-not-object');
  return { settings: parsed, snapshot };
}

/**
 * Land the new content through a temporary file and rename, so a crash never
 * leaves a truncated file. Claude Desktop and the CLI write this file too, so
 * the version the plan was computed from is re-checked right before the
 * rename and a changed file aborts the write without touching it.
 */
async function writeSettingsFile(
  path: string,
  settings: JsonObject,
  expected: SettingsSnapshot | undefined,
): Promise<void> {
  const target = expected?.target ?? path;
  const mode = expected?.mode ?? 0o600;
  const payload = `${JSON.stringify(settings, null, 2)}\n`;
  const temporaryPath = join(dirname(target), `.settings.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    if (expected === undefined) await mkdir(dirname(target), { mode: 0o700, recursive: true });
    const handle = await open(temporaryPath, 'wx', mode);
    try {
      // fchmod ignores the umask, so the file keeps exactly the mode it had.
      await handle.chmod(mode);
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await currentSnapshot(path);
    const unchanged =
      expected === undefined
        ? current === undefined
        : current !== undefined &&
          current.target === expected.target &&
          current.ino === expected.ino &&
          current.size === expected.size &&
          current.mtimeNs === expected.mtimeNs &&
          current.ctimeNs === expected.ctimeNs &&
          current.mode === expected.mode;
    if (!unchanged) throw new ClaudeHookSettingsError('settings-changed');
    await rename(temporaryPath, target);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof ClaudeHookSettingsError) throw error;
    throw new ClaudeHookSettingsError('settings-unwritable');
  }
}

function commandFor(options: ClaudeHookInstallerOptions): OwnedHookCommand {
  if (!isAbsolute(options.helperPath) || !isAbsolute(options.dataDirectory)) {
    throw new Error('Hook helper and data directory paths must be absolute');
  }
  return { helperPath: options.helperPath, dataDirectory: options.dataDirectory };
}

function isSameContent(a: JsonObject, b: JsonObject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Install or refresh the owned hooks. The planned file is compared with the
 * current one, so a complete install is never rewritten, including one the
 * user has silenced with `disableAllHooks`.
 */
export async function installClaudeHooks(
  options: ClaudeHookInstallerOptions,
): Promise<ClaudeHookChange> {
  const command = commandFor(options);
  const path = claudeSettingsPath(options.configDirectory);
  const { settings, snapshot } = await readClaudeSettingsFile(path);
  const next = planClaudeHookInstall(settings, command);
  if (snapshot !== undefined && isSameContent(next, settings)) return { changed: false };
  await writeSettingsFile(path, next, snapshot);
  return { changed: true };
}

/** Remove only the owned hooks; a file without any is left untouched. */
export async function removeClaudeHooks(
  options: Pick<ClaudeHookInstallerOptions, 'configDirectory'>,
): Promise<ClaudeHookChange> {
  const path = claudeSettingsPath(options.configDirectory);
  const { settings, snapshot } = await readClaudeSettingsFile(path);
  if (snapshot === undefined) return { changed: false };
  const next = planClaudeHookRemoval(settings);
  if (isSameContent(next, settings)) return { changed: false };
  await writeSettingsFile(path, next, snapshot);
  return { changed: true };
}

/** Report the owned-hook state of the settings file without writing. */
export async function inspectClaudeHooks(
  options: ClaudeHookInstallerOptions,
): Promise<ClaudeHookVerification> {
  const command = commandFor(options);
  try {
    const { settings } = await readClaudeSettingsFile(claudeSettingsPath(options.configDirectory));
    return verifyClaudeHooks(settings, command);
  } catch (error) {
    if (error instanceof ClaudeHookSettingsError && isReadCode(error.code)) {
      return { status: 'unreadable', code: error.code };
    }
    throw error;
  }
}

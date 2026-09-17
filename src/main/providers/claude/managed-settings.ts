import { readdir, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import {
  ClaudeHookSettingsError,
  errorCode,
  readClaudeSettingsFile,
  type JsonObject,
} from './hook-installer';

/**
 * Where Claude Code reads file-based managed settings on macOS; see the
 * "Deploy managed settings" page of the Claude Code documentation.
 */
export const CLAUDE_MANAGED_DIRECTORY = '/Library/Application Support/ClaudeCode';
const MANAGED_SETTINGS_FILE = 'managed-settings.json';
const MANAGED_DROP_IN_DIRECTORY = 'managed-settings.d';
/** The MDM preferences domain Claude Code reads; a plist here outranks the files. */
const MANAGED_PREFERENCES_DOMAIN = 'com.anthropic.claudecode';
const MANAGED_PREFERENCES_ROOT = '/Library/Managed Preferences';
/** More drop-in files than any real deployment; past it the merge is not attempted. */
export const MAX_MANAGED_DROP_INS = 64;

export interface ClaudeManagedLocations {
  /** Directory holding `managed-settings.json` and `managed-settings.d/`. */
  directory: string;
  /**
   * MDM configuration-profile plists for the Claude Code domain. Any that
   * exists is a higher-ranked managed source this module does not parse.
   */
  preferencesPaths: readonly string[];
}

export type ClaudeManagedHooksVerification =
  /** No file-based managed setting blocks hooks from the user settings file. */
  | { status: 'unrestricted' }
  /** A managed setting silences or excludes hooks from the user settings file. */
  | { status: 'restricted'; setting: ClaudeManagedHookSetting }
  /** The managed tier cannot be read or is delivered by a source this module does not parse. */
  | { status: 'unknown' };

/** The managed keys that keep user-level hooks from running. */
export type ClaudeManagedHookSetting =
  'disableAllHooks' | 'allowManagedHooksOnly' | 'strictPluginOnlyCustomization';

export function defaultClaudeManagedLocations(): ClaudeManagedLocations {
  const plist = `${MANAGED_PREFERENCES_DOMAIN}.plist`;
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    user = undefined;
  }
  return {
    directory: CLAUDE_MANAGED_DIRECTORY,
    preferencesPaths: [
      join(MANAGED_PREFERENCES_ROOT, plist),
      ...(user ? [join(MANAGED_PREFERENCES_ROOT, user, plist)] : []),
    ],
  };
}

/** Whether any MDM plist for the domain exists; unreadable counts as present. */
async function hasManagedPreferences(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') return true;
    }
  }
  return false;
}

/**
 * The drop-in files Claude Code merges after `managed-settings.json`: visible
 * `*.json` entries in alphabetical order. Undefined means the directory could
 * not be listed or holds more files than the bound.
 */
async function listDropIns(directory: string): Promise<string[] | undefined> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return [];
    return undefined;
  }
  const dropIns = names.filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort();
  if (dropIns.length > MAX_MANAGED_DROP_INS) return undefined;
  return dropIns.map((name) => join(directory, name));
}

/** Read one managed file as a JSON object; undefined when absent, throws when unreadable. */
async function readManagedFile(path: string): Promise<JsonObject | undefined> {
  const { settings, snapshot } = await readClaudeSettingsFile(path);
  return snapshot === undefined ? undefined : settings;
}

/**
 * The merged value of the three keys that decide whether hooks from the
 * user settings file run, following Claude Code's drop-in rules: a later
 * single value replaces an earlier one and lists combine.
 */
interface MergedHookPolicy {
  disableAllHooks: unknown;
  allowManagedHooksOnly: unknown;
  /** True once any file locks every surface; the array collects named surfaces. */
  lockAllSurfaces: boolean;
  lockedSurfaces: Set<unknown>;
}

function mergeHookPolicy(policy: MergedHookPolicy, settings: JsonObject): void {
  if (Object.hasOwn(settings, 'disableAllHooks')) policy.disableAllHooks = settings.disableAllHooks;
  if (Object.hasOwn(settings, 'allowManagedHooksOnly')) {
    policy.allowManagedHooksOnly = settings.allowManagedHooksOnly;
  }
  const strict = settings.strictPluginOnlyCustomization;
  if (strict === true) {
    policy.lockAllSurfaces = true;
  } else if (Array.isArray(strict)) {
    // Lists combine with an earlier list, but a later value replaces an
    // earlier single value, so an array after `true` names the locks anew.
    policy.lockAllSurfaces = false;
    for (const surface of strict) policy.lockedSurfaces.add(surface);
  } else if (strict === false) {
    // A later single value replaces the earlier one, so an explicit `false`
    // lifts every lock a previous file set.
    policy.lockAllSurfaces = false;
    policy.lockedSurfaces.clear();
  }
}

function restrictingSetting(policy: MergedHookPolicy): ClaudeManagedHookSetting | undefined {
  if (policy.disableAllHooks === true) return 'disableAllHooks';
  // Claude Code treats an invalid value as `true` until it is fixed.
  if (policy.allowManagedHooksOnly !== undefined && policy.allowManagedHooksOnly !== false) {
    return 'allowManagedHooksOnly';
  }
  if (policy.lockAllSurfaces || policy.lockedSurfaces.has('hooks')) {
    return 'strictPluginOnlyCustomization';
  }
  return undefined;
}

/**
 * Report whether the file-based managed settings keep hooks in the user
 * settings file from running. Only `managed-settings.json` and its drop-in
 * directory are read: an MDM profile, server-managed settings, and an
 * embedding host's settings are not parsed. A present MDM profile outranks
 * the files under Claude Code's default first-wins rule, so with one present
 * the answer is unknown rather than a possible false alarm. Nothing here
 * reads the user's home directory, and no path leaves this function.
 */
export async function inspectClaudeManagedHooks(
  locations: ClaudeManagedLocations = defaultClaudeManagedLocations(),
): Promise<ClaudeManagedHooksVerification> {
  if (await hasManagedPreferences(locations.preferencesPaths)) return { status: 'unknown' };
  const dropIns = await listDropIns(join(locations.directory, MANAGED_DROP_IN_DIRECTORY));
  if (dropIns === undefined) return { status: 'unknown' };
  const policy: MergedHookPolicy = {
    disableAllHooks: undefined,
    allowManagedHooksOnly: undefined,
    lockAllSurfaces: false,
    lockedSurfaces: new Set(),
  };
  try {
    for (const path of [join(locations.directory, MANAGED_SETTINGS_FILE), ...dropIns]) {
      const settings = await readManagedFile(path);
      if (settings !== undefined) mergeHookPolicy(policy, settings);
    }
  } catch (error) {
    // A managed file Claude Code itself cannot parse stops Claude Code from
    // starting; either way this app cannot tell what applies.
    if (error instanceof ClaudeHookSettingsError) return { status: 'unknown' };
    throw error;
  }
  const setting = restrictingSetting(policy);
  return setting === undefined ? { status: 'unrestricted' } : { status: 'restricted', setting };
}

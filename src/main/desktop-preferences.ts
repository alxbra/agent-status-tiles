import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  DESKTOP_PREFERENCES_SCHEMA_VERSION,
  isSerializedDisplayId,
  PRIMARY_DISPLAY_ID,
} from '../shared/settings';

export const DESKTOP_PREFERENCES_FILE = 'desktop-preferences.json';
export const MAX_DESKTOP_PREFERENCES_BYTES = 16 * 1024;

export interface DesktopPreferences {
  schemaVersion: typeof DESKTOP_PREFERENCES_SCHEMA_VERSION;
  preferredDisplayId: string;
  reduceMotion: boolean;
}

export type DesktopPreferencesErrorCode = 'corrupt' | 'oversized' | 'unsafe' | 'io';

export class DesktopPreferencesError extends Error {
  constructor(
    readonly code: DesktopPreferencesErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DesktopPreferencesError';
  }
}

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = Object.freeze({
  schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
  preferredDisplayId: PRIMARY_DISPLAY_ID,
  reduceMotion: false,
});

const PREFERENCES_KEYS = ['schemaVersion', 'preferredDisplayId', 'reduceMotion'] as const;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

function clonePreferences(preferences: DesktopPreferences): DesktopPreferences {
  return { ...preferences };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === PREFERENCES_KEYS.length &&
    keys.every((key) => PREFERENCES_KEYS.includes(key as never))
  );
}

function decodePreferences(value: unknown): DesktopPreferences {
  if (
    !isRecord(value) ||
    !hasExactKeys(value) ||
    value.schemaVersion !== DESKTOP_PREFERENCES_SCHEMA_VERSION ||
    !isSerializedDisplayId(value.preferredDisplayId) ||
    typeof value.reduceMotion !== 'boolean'
  ) {
    throw new DesktopPreferencesError('corrupt', 'Desktop preferences are malformed.');
  }

  return {
    schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
    preferredDisplayId: value.preferredDisplayId,
    reduceMotion: value.reduceMotion,
  };
}

function assertPreferencesPath(userDataPath: string): string {
  if (typeof userDataPath !== 'string' || !isAbsolute(userDataPath)) {
    throw new DesktopPreferencesError('unsafe', 'User-data path must be absolute.');
  }
  return resolve(userDataPath);
}

function assertPrivateDirectory(directoryPath: string): void {
  try {
    const directory = lstatSync(directoryPath);
    if (directory.isSymbolicLink()) {
      throw new DesktopPreferencesError('unsafe', 'User-data directory must not be a symlink.');
    }
    if (!directory.isDirectory()) {
      throw new DesktopPreferencesError('unsafe', 'User-data path is not a directory.');
    }
  } catch (error) {
    if (error instanceof DesktopPreferencesError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DesktopPreferencesError('io', 'Unable to inspect user-data directory.', error);
    }
    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    const created = lstatSync(directoryPath);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new DesktopPreferencesError('unsafe', 'User-data directory is unsafe.');
    }
  }
}

function readPreferencesFile(preferencesPath: string): DesktopPreferences {
  let fileStats;
  try {
    fileStats = lstatSync(preferencesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return clonePreferences(DEFAULT_DESKTOP_PREFERENCES);
    }
    throw new DesktopPreferencesError('io', 'Unable to inspect desktop preferences.', error);
  }
  if (fileStats.isSymbolicLink()) {
    throw new DesktopPreferencesError('unsafe', 'Desktop preferences must not be a symlink.');
  }
  if (!fileStats.isFile() || fileStats.size > MAX_DESKTOP_PREFERENCES_BYTES) {
    throw new DesktopPreferencesError('oversized', 'Desktop preferences exceed the storage bound.');
  }

  let descriptor: number | undefined;
  let payload: string;
  try {
    descriptor = openSync(preferencesPath, constants.O_RDONLY | NO_FOLLOW | NONBLOCK);
    const openedStats = fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.size > MAX_DESKTOP_PREFERENCES_BYTES) {
      throw new DesktopPreferencesError(
        'oversized',
        'Desktop preferences exceed the storage bound.',
      );
    }
    const buffer = Buffer.allocUnsafe(MAX_DESKTOP_PREFERENCES_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_DESKTOP_PREFERENCES_BYTES) {
      throw new DesktopPreferencesError(
        'oversized',
        'Desktop preferences exceed the storage bound.',
      );
    }
    payload = buffer.toString('utf8', 0, bytesRead);
  } catch (error) {
    if (error instanceof DesktopPreferencesError) throw error;
    throw new DesktopPreferencesError('io', 'Unable to read desktop preferences.', error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_DESKTOP_PREFERENCES_BYTES) {
    throw new DesktopPreferencesError('oversized', 'Desktop preferences exceed the storage bound.');
  }
  try {
    return decodePreferences(JSON.parse(payload) as unknown);
  } catch (error) {
    if (error instanceof DesktopPreferencesError) throw error;
    throw new DesktopPreferencesError('corrupt', 'Desktop preferences are not valid JSON.', error);
  }
}

function encodePreferences(preferences: DesktopPreferences): string {
  const decoded = decodePreferences(preferences);
  const payload = `${JSON.stringify(decoded)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_DESKTOP_PREFERENCES_BYTES) {
    throw new DesktopPreferencesError('oversized', 'Desktop preferences exceed the storage bound.');
  }
  return payload;
}

function writePreferencesFile(
  directoryPath: string,
  preferencesPath: string,
  payload: string,
): void {
  assertPrivateDirectory(directoryPath);
  try {
    const existing = lstatSync(preferencesPath);
    if (existing.isSymbolicLink()) {
      throw new DesktopPreferencesError('unsafe', 'Desktop preferences must not be a symlink.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryPath = join(
    directoryPath,
    `.${DESKTOP_PREFERENCES_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    writeFileSync(descriptor, payload, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, preferencesPath);
  } catch (error) {
    if (error instanceof DesktopPreferencesError) throw error;
    throw new DesktopPreferencesError(
      'io',
      'Unable to atomically save desktop preferences.',
      error,
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original write error is more useful to callers.
      }
    }
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best effort cleanup; the atomically written destination is unaffected.
      }
    }
  }
}

export function loadDesktopPreferences(userDataPath: string): DesktopPreferences {
  const directoryPath = assertPreferencesPath(userDataPath);
  try {
    assertPrivateDirectory(directoryPath);
    return readPreferencesFile(join(directoryPath, DESKTOP_PREFERENCES_FILE));
  } catch {
    // Preferences are optional. Any damaged or inaccessible value fails closed to defaults.
    return clonePreferences(DEFAULT_DESKTOP_PREFERENCES);
  }
}

export function saveDesktopPreferences(
  userDataPath: string,
  preferences: DesktopPreferences,
): void {
  const directoryPath = assertPreferencesPath(userDataPath);
  const payload = encodePreferences(preferences);
  writePreferencesFile(directoryPath, join(directoryPath, DESKTOP_PREFERENCES_FILE), payload);
}

export class DesktopPreferencesStore {
  readonly userDataPath: string;
  private preferences: DesktopPreferences;

  constructor(userDataPath: string) {
    this.userDataPath = assertPreferencesPath(userDataPath);
    this.preferences = loadDesktopPreferences(this.userDataPath);
  }

  get(): DesktopPreferences {
    return clonePreferences(this.preferences);
  }

  setDisplayPreference(preferredDisplayId: string): DesktopPreferences {
    const next: DesktopPreferences = {
      ...this.preferences,
      preferredDisplayId,
    };
    saveDesktopPreferences(this.userDataPath, next);
    this.preferences = next;
    return this.get();
  }

  setReduceMotion(reduceMotion: boolean): DesktopPreferences {
    const next: DesktopPreferences = {
      ...this.preferences,
      reduceMotion,
    };
    saveDesktopPreferences(this.userDataPath, next);
    this.preferences = next;
    return this.get();
  }
}

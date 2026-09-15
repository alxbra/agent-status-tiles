import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DESKTOP_PREFERENCES_FILE,
  DEFAULT_DESKTOP_PREFERENCES,
  DesktopPreferencesStore,
  loadDesktopPreferences,
  MAX_DESKTOP_PREFERENCES_BYTES,
  saveDesktopPreferences,
} from '../../src/main/desktop-preferences';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agent-status-tiles-preferences-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('desktop preference store', () => {
  it('fails closed for missing, malformed, unknown, and unsupported data', () => {
    const directory = temporaryDirectory();
    expect(loadDesktopPreferences(directory)).toEqual(DEFAULT_DESKTOP_PREFERENCES);

    const path = join(directory, DESKTOP_PREFERENCES_FILE);
    for (const value of [
      '{not-json',
      JSON.stringify({ schemaVersion: 2, preferredDisplayId: '42', reduceMotion: true }),
      JSON.stringify({
        schemaVersion: 1,
        preferredDisplayId: 'not-an-electron-id',
        reduceMotion: true,
      }),
      JSON.stringify({
        schemaVersion: 1,
        preferredDisplayId: '42',
        reduceMotion: true,
        extra: 'not allowed',
      }),
    ]) {
      writeFileSync(path, value, 'utf8');
      expect(loadDesktopPreferences(directory)).toEqual(DEFAULT_DESKTOP_PREFERENCES);
    }
  });

  it('persists only allowlisted preferences and preserves an absent physical display', () => {
    const directory = temporaryDirectory();
    const store = new DesktopPreferencesStore(directory);
    expect(store.setDisplayPreference('42')).toMatchObject({
      preferredDisplayId: '42',
      reduceMotion: false,
    });
    expect(store.setReduceMotion(true)).toMatchObject({
      preferredDisplayId: '42',
      reduceMotion: true,
    });

    const raw = JSON.parse(
      readFileSync(join(directory, DESKTOP_PREFERENCES_FILE), 'utf8'),
    ) as unknown;
    expect(raw).toEqual({ schemaVersion: 1, preferredDisplayId: '42', reduceMotion: true });
    expect(new DesktopPreferencesStore(directory).get()).toEqual(raw);
  });

  it('uses an atomic replacement and leaves no temporary preference files', () => {
    const directory = temporaryDirectory();
    saveDesktopPreferences(directory, {
      schemaVersion: 1,
      preferredDisplayId: 'primary',
      reduceMotion: false,
    });
    saveDesktopPreferences(directory, {
      schemaVersion: 1,
      preferredDisplayId: '7',
      reduceMotion: true,
    });

    expect(readdirSync(directory)).toEqual([DESKTOP_PREFERENCES_FILE]);
    expect(loadDesktopPreferences(directory).preferredDisplayId).toBe('7');
  });

  it('fails closed without reading beyond the fixed preference bound', () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, DESKTOP_PREFERENCES_FILE),
      Buffer.alloc(MAX_DESKTOP_PREFERENCES_BYTES + 1, 0x20),
    );

    expect(loadDesktopPreferences(directory)).toEqual(DEFAULT_DESKTOP_PREFERENCES);
  });
});

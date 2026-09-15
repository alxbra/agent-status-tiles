import { describe, expect, it } from 'vitest';
import type { LoginItemSettings } from 'electron';

import { evaluateLoginItemSettings, shouldOpenSettingsAtStartup } from '../../src/main/login-item';

function loginSettings(overrides: Partial<LoginItemSettings> = {}): LoginItemSettings {
  return {
    openAtLogin: false,
    wasOpenedAtLogin: false,
    status: 'not-registered',
    executableWillLaunchAtLogin: false,
    launchItems: [],
    ...overrides,
  };
}

describe('login-item lifecycle', () => {
  it('suppresses the initial Settings window for a login-item launch', () => {
    expect(shouldOpenSettingsAtStartup(loginSettings())).toBe(true);
    expect(shouldOpenSettingsAtStartup(loginSettings({ wasOpenedAtLogin: true }))).toBe(false);
  });

  it('only reports launch at login as enabled when macOS confirms it', () => {
    expect(
      evaluateLoginItemSettings(loginSettings({ openAtLogin: true, status: 'enabled' })),
    ).toEqual({ enabled: true });
    expect(
      evaluateLoginItemSettings(loginSettings({ openAtLogin: true, status: 'requires-approval' })),
    ).toEqual({
      enabled: false,
      error: 'Allow Agent Status Tiles in System Settings > General > Login Items.',
    });
  });

  it('surfaces unsuccessful enable and disable requests', () => {
    expect(evaluateLoginItemSettings(loginSettings(), true)).toEqual({
      enabled: false,
      error: 'Launch at login could not be enabled. Try again.',
    });
    expect(
      evaluateLoginItemSettings(loginSettings({ openAtLogin: true, status: 'enabled' }), false),
    ).toEqual({
      enabled: true,
      error: 'Launch at login could not be disabled. Try again.',
    });
    expect(
      evaluateLoginItemSettings(
        loginSettings({ openAtLogin: false, status: 'requires-approval' }),
        false,
      ),
    ).toEqual({ enabled: false });
  });
});

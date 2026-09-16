import { describe, expect, it } from 'vitest';
import {
  isSettingsConnectionKey,
  isSettingsConnectionRequest,
  isSettingsDisconnectRequest,
  isSettingsState,
} from '../../src/shared/settings';

describe('settings connection boundary', () => {
  it('accepts only exact surface keys and payload fields', () => {
    for (const connection of ['codexDesktop', 'codexCli', 'claudeCode']) {
      expect(isSettingsConnectionKey(connection)).toBe(true);
      expect(isSettingsConnectionRequest({ connection })).toBe(true);
      expect(isSettingsDisconnectRequest({ connection, confirmed: true })).toBe(true);
    }
    expect(isSettingsConnectionKey('codex')).toBe(false);
    expect(isSettingsConnectionRequest({ connection: 'codexDesktop', path: '/private' })).toBe(
      false,
    );
    expect(isSettingsDisconnectRequest({ connection: 'codexDesktop' })).toBe(false);
    expect(isSettingsDisconnectRequest({ connection: 'codexDesktop', confirmed: false })).toBe(
      false,
    );
  });

  it('requires all three independent connection rows in Settings state', () => {
    const state = {
      providers: {
        codexDesktop: { status: 'disconnected', canConnect: true, canDisconnect: false },
        codexCli: { status: 'unavailable', canConnect: false, canDisconnect: false },
        claudeCode: { status: 'unavailable', canConnect: false, canDisconnect: false },
      },
      displays: [{ id: 'primary', label: 'Primary' }],
      selectedDisplayId: 'primary',
      launchAtLogin: false,
      reduceMotion: false,
    };
    expect(isSettingsState(state)).toBe(true);
    expect(
      isSettingsState({ ...state, providers: { codexDesktop: state.providers.codexDesktop } }),
    ).toBe(false);
  });
});

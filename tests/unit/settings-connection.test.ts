import { describe, expect, it } from 'vitest';
import {
  isSettingsConnectionKey,
  isSettingsConnectionRequest,
  isSettingsDisconnectRequest,
  isSettingsState,
} from '../../src/shared/settings';

describe('settings connection boundary', () => {
  it('accepts only exact surface keys and payload fields', () => {
    for (const connection of ['codex', 'claude']) {
      expect(isSettingsConnectionKey(connection)).toBe(true);
      expect(isSettingsConnectionRequest({ connection })).toBe(true);
      expect(isSettingsDisconnectRequest({ connection, confirmed: true })).toBe(true);
    }
    // Surfaces are bundled behind their provider row; per-surface keys are not accepted.
    for (const legacy of ['codexDesktop', 'codexCli', 'claudeCode']) {
      expect(isSettingsConnectionKey(legacy)).toBe(false);
    }
    expect(isSettingsConnectionRequest({ connection: 'codex', path: '/private' })).toBe(false);
    expect(isSettingsDisconnectRequest({ connection: 'codex' })).toBe(false);
    expect(isSettingsDisconnectRequest({ connection: 'codex', confirmed: false })).toBe(false);
  });

  it('requires exactly one row per provider in Settings state', () => {
    const state = {
      providers: {
        codex: { status: 'disconnected', canConnect: true, canDisconnect: false },
        claude: { status: 'unavailable', canConnect: false, canDisconnect: false },
      },
      displays: [{ id: 'primary', label: 'Primary' }],
      selectedDisplayId: 'primary',
      launchAtLogin: false,
      reduceMotion: false,
      recentThreadLimit: 5,
    };
    expect(isSettingsState(state)).toBe(true);
    expect(isSettingsState({ ...state, providers: { codex: state.providers.codex } })).toBe(false);
    expect(
      isSettingsState({
        ...state,
        providers: { ...state.providers, codexCli: state.providers.codex },
      }),
    ).toBe(false);
  });
});

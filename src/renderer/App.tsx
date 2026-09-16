import { useEffect, useState, type ReactElement } from 'react';

import {
  PRIMARY_DISPLAY_ID,
  type SettingsConnectionKey,
  type SettingsState,
} from '../shared/settings';
import { SettingsView, type SettingsProviderState } from './settings';
import { SettingsLoadSequence } from './settings-load-sequence';

function useSystemAppearance(): void {
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateAppearance = (): void => {
      document.documentElement.classList.toggle('dark', mediaQuery.matches);
    };

    updateAppearance();
    mediaQuery.addEventListener('change', updateAppearance);
    return () => mediaQuery.removeEventListener('change', updateAppearance);
  }, []);
}

const unavailableProvider: SettingsProviderState = {
  status: 'unavailable',
  canConnect: false,
  canDisconnect: false,
};

const INITIAL_SETTINGS: SettingsState = {
  providers: {
    codexDesktop: unavailableProvider,
    codexCli: unavailableProvider,
    claudeCode: unavailableProvider,
  },
  displays: [{ id: PRIMARY_DISPLAY_ID, label: 'Primary' }],
  selectedDisplayId: PRIMARY_DISPLAY_ID,
  launchAtLogin: false,
  reduceMotion: false,
};

export function App(): ReactElement {
  useSystemAppearance();
  const [settings, setSettings] = useState<SettingsState>(INITIAL_SETTINGS);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let mounted = true;
    const loadSequence = new SettingsLoadSequence();
    const unsubscribe = window.agentStatusTiles.subscribeSettings((nextSettings) => {
      loadSequence.markPublicationReceived();
      if (mounted) {
        setError(undefined);
        setSettings(nextSettings);
      }
    });
    void window.agentStatusTiles
      .getSettings()
      .then((nextSettings) => {
        if (mounted && loadSequence.shouldAcceptInitialResult()) {
          setError(undefined);
          setSettings(nextSettings);
        }
      })
      .catch(() => {
        if (mounted && loadSequence.shouldAcceptInitialResult()) {
          setError('Could not load settings. Try again.');
        }
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return (
    <SettingsView
      advancedDisabled
      displays={settings.displays}
      error={error ?? settings.error}
      launchAtLogin={settings.launchAtLogin}
      onConnect={async (connection: SettingsConnectionKey) => {
        const nextSettings = await window.agentStatusTiles.connectSurface(connection);
        setError(undefined);
        setSettings(nextSettings);
      }}
      onDisconnect={async (connection: SettingsConnectionKey) => {
        const nextSettings = await window.agentStatusTiles.disconnectSurface(connection, true);
        setError(undefined);
        setSettings(nextSettings);
      }}
      onDisplayChange={async (displayId) => {
        const nextSettings = await window.agentStatusTiles.setDisplayPreference(displayId);
        setError(undefined);
        setSettings(nextSettings);
      }}
      onLaunchAtLoginChange={async (enabled) => {
        const nextSettings = await window.agentStatusTiles.setLaunchAtLogin(enabled);
        setError(undefined);
        setSettings(nextSettings);
      }}
      onReduceMotionChange={async (enabled) => {
        const nextSettings = await window.agentStatusTiles.setReduceMotion(enabled);
        setError(undefined);
        setSettings(nextSettings);
      }}
      providers={settings.providers}
      reduceMotion={settings.reduceMotion}
      selectedDisplayId={settings.selectedDisplayId}
    />
  );
}

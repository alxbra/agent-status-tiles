import { useEffect, useState, type ReactElement } from 'react';

import { PRIMARY_DISPLAY_ID, type SettingsState } from '../shared/settings';
import { SettingsView, type SettingsProviderState } from './settings';

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
    codex: unavailableProvider,
    claude: unavailableProvider,
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
    let receivedPublishedSettings = false;
    const unsubscribe = window.agentStatusTiles.subscribeSettings((nextSettings) => {
      receivedPublishedSettings = true;
      if (mounted) setSettings(nextSettings);
    });
    void window.agentStatusTiles
      .getSettings()
      .then((nextSettings) => {
        if (mounted && !receivedPublishedSettings) setSettings(nextSettings);
      })
      .catch(() => {
        if (mounted) setError('Could not load settings. Try again.');
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
      error={error}
      launchAtLogin={settings.launchAtLogin}
      onDisplayChange={async (displayId) => {
        const nextSettings = await window.agentStatusTiles.setDisplayPreference(displayId);
        setSettings(nextSettings);
      }}
      onLaunchAtLoginChange={async (enabled) => {
        const nextSettings = await window.agentStatusTiles.setLaunchAtLogin(enabled);
        setSettings(nextSettings);
      }}
      onReduceMotionChange={async (enabled) => {
        const nextSettings = await window.agentStatusTiles.setReduceMotion(enabled);
        setSettings(nextSettings);
      }}
      providers={settings.providers}
      reduceMotion={settings.reduceMotion}
      selectedDisplayId={settings.selectedDisplayId}
    />
  );
}

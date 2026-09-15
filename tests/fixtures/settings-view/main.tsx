import { StrictMode, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { Provider } from '../../../src/shared/session';
import {
  SettingsView,
  type SettingsDisplayOption,
  type SettingsProviderState,
} from '../../../src/renderer/settings';
import '../../../src/renderer/styles.css';

const displays: readonly SettingsDisplayOption[] = [
  { id: 'primary', label: 'Primary' },
  { id: 'built-in', label: 'Built-in Display' },
];

type FixtureState = {
  providers: Readonly<Record<Provider, SettingsProviderState>>;
  selectedDisplayId: string;
  launchAtLogin: boolean;
  reduceMotion: boolean;
};

const initialState: FixtureState = {
  providers: {
    codex: { status: 'disconnected', canConnect: true, canDisconnect: false },
    claude: { status: 'disconnected', canConnect: true, canDisconnect: false },
  },
  selectedDisplayId: 'primary',
  launchAtLogin: false,
  reduceMotion: false,
};

type FixtureWindow = Window & {
  __settingsFixture?: {
    rejectNextAction: () => void;
  };
};

function SettingsFixture(): ReactElement {
  const [state, setState] = useState(initialState);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const rejectNext = useRef(false);

  const update = (change: (current: FixtureState) => FixtureState): Promise<void> =>
    new Promise((resolve, reject) => {
      window.setTimeout(() => {
        if (rejectNext.current) {
          rejectNext.current = false;
          reject(new Error('fixture action failed'));
          return;
        }
        setState(change);
        resolve();
      }, 20);
    });

  (window as FixtureWindow).__settingsFixture = {
    rejectNextAction: () => {
      rejectNext.current = true;
    },
  };

  return (
    <>
      <SettingsView
        displays={displays}
        launchAtLogin={state.launchAtLogin}
        onConnect={(provider) =>
          update((current) => {
            return {
              ...current,
              providers: {
                ...current.providers,
                [provider]: { status: 'connected', canConnect: false, canDisconnect: true },
              },
            };
          })
        }
        onDisconnect={(provider) =>
          update((current) => ({
            ...current,
            providers: {
              ...current.providers,
              [provider]: { status: 'disconnected', canConnect: true, canDisconnect: false },
            },
          }))
        }
        onDisplayChange={(selectedDisplayId) =>
          update((current) => ({ ...current, selectedDisplayId }))
        }
        onLaunchAtLoginChange={(launchAtLogin) =>
          update((current) => ({ ...current, launchAtLogin }))
        }
        onOpenAdvanced={() => setAdvancedOpen(true)}
        onReduceMotionChange={(reduceMotion) => update((current) => ({ ...current, reduceMotion }))}
        providers={state.providers}
        reduceMotion={state.reduceMotion}
        selectedDisplayId={state.selectedDisplayId}
      />
      {advancedOpen ? <span data-testid="advanced-opened">Advanced opened</span> : null}
    </>
  );
}

const theme = new URLSearchParams(window.location.search).get('theme');
document.documentElement.classList.toggle('dark', theme === 'dark');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsFixture />
  </StrictMode>,
);

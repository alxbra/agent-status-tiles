import { StrictMode, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { SettingsConnectionKey } from '../../../src/shared/settings';
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
  providers: Readonly<Record<SettingsConnectionKey, SettingsProviderState>>;
  selectedDisplayId: string;
  launchAtLogin: boolean;
  reduceMotion: boolean;
  recentThreadLimit: number;
  error?: string;
};

const initialState: FixtureState = {
  providers: {
    codexDesktop: { status: 'disconnected', canConnect: true, canDisconnect: false },
    codexCli: { status: 'disconnected', canConnect: true, canDisconnect: false },
    claudeCode: { status: 'disconnected', canConnect: false, canDisconnect: false },
  },
  selectedDisplayId: 'primary',
  launchAtLogin: false,
  reduceMotion: false,
  recentThreadLimit: 5,
};

type FixtureWindow = Window & {
  __settingsFixture?: {
    deferNextAction: () => void;
    getProviderActionCalls: (connection: SettingsConnectionKey) => number;
    markProviderConnected: (connection: SettingsConnectionKey) => void;
    rejectNextAction: () => void;
    resolveDeferredAction: () => void;
    setExternalError: (error: string) => void;
  };
};

function SettingsFixture(): ReactElement {
  const [state, setState] = useState(initialState);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const hasDeferredNextAction = useRef(false);
  const deferredAction = useRef<(() => void) | undefined>(undefined);
  const providerActionCalls = useRef<Record<SettingsConnectionKey, number>>({
    codexDesktop: 0,
    codexCli: 0,
    claudeCode: 0,
  });
  const hasRejectedNextAction = useRef(false);

  const update = (change: (current: FixtureState) => FixtureState): Promise<void> =>
    new Promise((resolve, reject) => {
      const complete = (): void => {
        if (hasRejectedNextAction.current) {
          hasRejectedNextAction.current = false;
          reject(new Error('fixture action failed'));
          return;
        }
        setState(change);
        resolve();
      };

      if (hasDeferredNextAction.current) {
        hasDeferredNextAction.current = false;
        deferredAction.current = complete;
      } else {
        window.setTimeout(complete, 20);
      }
    });

  const setProviderStatus = (
    connection: SettingsConnectionKey,
    status: SettingsProviderState['status'],
  ): void => {
    setState((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [connection]: {
          status,
          canConnect: status !== 'connected',
          canDisconnect: status === 'connected',
        },
      },
    }));
  };

  (window as FixtureWindow).__settingsFixture = {
    deferNextAction: () => {
      hasDeferredNextAction.current = true;
    },
    getProviderActionCalls: (provider) => providerActionCalls.current[provider],
    markProviderConnected: (provider) => setProviderStatus(provider, 'connected'),
    rejectNextAction: () => {
      hasRejectedNextAction.current = true;
    },
    resolveDeferredAction: () => {
      const complete = deferredAction.current;
      deferredAction.current = undefined;
      complete?.();
    },
    setExternalError: (error) => setState((current) => ({ ...current, error })),
  };

  return (
    <>
      <SettingsView
        displays={displays}
        error={state.error}
        launchAtLogin={state.launchAtLogin}
        recentThreadLimit={state.recentThreadLimit}
        onRecentThreadLimitChange={(limit) =>
          update((current) => ({ ...current, recentThreadLimit: limit }))
        }
        onConnect={(provider) => {
          providerActionCalls.current[provider] += 1;
          return update((current) => ({
            ...current,
            providers: {
              ...current.providers,
              [provider]: { status: 'connected', canConnect: false, canDisconnect: true },
            },
          }));
        }}
        onDisconnect={(connection) => {
          providerActionCalls.current[connection] += 1;
          return update((current) => ({
            ...current,
            providers: {
              ...current.providers,
              [connection]: { status: 'disconnected', canConnect: true, canDisconnect: false },
            },
          }));
        }}
        onDisplayChange={(selectedDisplayId) =>
          update((current) => ({ ...current, selectedDisplayId }))
        }
        onLaunchAtLoginChange={(launchAtLogin) =>
          update((current) => ({ ...current, launchAtLogin }))
        }
        onOpenAdvanced={() => setIsAdvancedOpen(true)}
        onReduceMotionChange={(reduceMotion) => update((current) => ({ ...current, reduceMotion }))}
        providers={state.providers}
        reduceMotion={state.reduceMotion}
        selectedDisplayId={state.selectedDisplayId}
      />
      {isAdvancedOpen ? <span data-testid="advanced-opened">Advanced opened</span> : null}
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

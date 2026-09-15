import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { useCallback, useRef, useState, type ReactElement } from 'react';

import type { Provider } from '../../shared/session';
import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Switch } from '../components/ui/switch';

const PROVIDER_LABEL: Readonly<Record<Provider, string>> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

export type ProviderConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'unavailable';

export interface SettingsProviderState {
  status: ProviderConnectionStatus;
  canConnect: boolean;
  canDisconnect: boolean;
}

export interface SettingsDisplayOption {
  id: string;
  label: string;
}

export interface SettingsViewProps {
  providers: Readonly<Record<Provider, SettingsProviderState>>;
  displays: readonly SettingsDisplayOption[];
  selectedDisplayId: string;
  launchAtLogin: boolean;
  reduceMotion: boolean;
  error?: string;
  onConnect: (provider: Provider) => void | Promise<void>;
  onDisconnect: (provider: Provider) => void | Promise<void>;
  onDisplayChange: (displayId: string) => void | Promise<void>;
  onLaunchAtLoginChange: (enabled: boolean) => void | Promise<void>;
  onReduceMotionChange: (enabled: boolean) => void | Promise<void>;
  onOpenAdvanced: () => void;
}

function ProviderAction({
  provider,
  state,
  isPending,
  onConnect,
  onDisconnect,
}: {
  provider: Provider;
  state: SettingsProviderState;
  isPending: (action: SettingsAction) => boolean;
  onConnect: (provider: Provider) => void | Promise<void>;
  onDisconnect: (provider: Provider) => void | Promise<void>;
}): ReactElement {
  const label = PROVIDER_LABEL[provider];
  const disconnectPending = isPending(`disconnect:${provider}`);
  if (state.status === 'connected') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Connected</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Actions for ${label}`}
              size="icon-sm"
              variant="ghost"
              type="button"
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!state.canDisconnect || disconnectPending}
              onSelect={() => void onDisconnect(provider)}
            >
              {disconnectPending ? 'Disconnecting…' : 'Disconnect'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  const pending = state.status === 'connecting' || isPending(`connect:${provider}`);
  return (
    <Button
      disabled={pending || !state.canConnect}
      onClick={() => void onConnect(provider)}
      size="sm"
      type="button"
      variant="outline"
    >
      {pending ? 'Connecting…' : 'Connect'}
    </Button>
  );
}

function SettingRow({
  children,
  label,
  htmlFor,
}: {
  children: ReactElement;
  label: string;
  htmlFor?: string;
}): ReactElement {
  return (
    <div className="flex min-h-9 items-center justify-between gap-6">
      {htmlFor === undefined ? (
        <span className="text-sm font-medium">{label}</span>
      ) : (
        <label className="text-sm font-medium" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

type SettingsAction =
  | `connect:${Provider}`
  | `disconnect:${Provider}`
  | 'display'
  | 'launch-at-login'
  | 'reduce-motion';

type SettingsActionRunner = (
  action: SettingsAction,
  failureMessage: string,
  operation: () => void | Promise<void>,
) => void;

export function SettingsView({
  providers,
  displays,
  selectedDisplayId,
  launchAtLogin,
  reduceMotion,
  error,
  onConnect,
  onDisconnect,
  onDisplayChange,
  onLaunchAtLoginChange,
  onReduceMotionChange,
  onOpenAdvanced,
}: SettingsViewProps): ReactElement {
  const pendingRef = useRef<Set<SettingsAction>>(new Set());
  const [pendingActions, setPendingActions] = useState<ReadonlySet<SettingsAction>>(new Set());
  const [actionError, setActionError] = useState<string>();

  const runAction = useCallback<SettingsActionRunner>((action, failureMessage, operation) => {
    if (pendingRef.current.has(action)) return;

    pendingRef.current.add(action);
    setPendingActions(new Set(pendingRef.current));
    setActionError(undefined);

    void Promise.resolve()
      .then(operation)
      .catch(() => setActionError(failureMessage))
      .finally(() => {
        pendingRef.current.delete(action);
        setPendingActions(new Set(pendingRef.current));
      });
  }, []);

  const isPending = useCallback(
    (action: SettingsAction): boolean => pendingActions.has(action),
    [pendingActions],
  );

  const connect = useCallback<SettingsViewProps['onConnect']>(
    (provider) =>
      runAction(
        `connect:${provider}`,
        `Could not connect to ${PROVIDER_LABEL[provider]}. Try again.`,
        () => onConnect(provider),
      ),
    [onConnect, runAction],
  );

  const disconnect = useCallback<SettingsViewProps['onDisconnect']>(
    (provider) =>
      runAction(
        `disconnect:${provider}`,
        `Could not disconnect ${PROVIDER_LABEL[provider]}. Try again.`,
        () => onDisconnect(provider),
      ),
    [onDisconnect, runAction],
  );

  const changeDisplay = useCallback<SettingsViewProps['onDisplayChange']>(
    (displayId) =>
      runAction('display', 'Could not change the display. Try again.', () =>
        onDisplayChange(displayId),
      ),
    [onDisplayChange, runAction],
  );

  const changeLaunchAtLogin = useCallback<SettingsViewProps['onLaunchAtLoginChange']>(
    (enabled) =>
      runAction('launch-at-login', 'Could not change Launch at login. Try again.', () =>
        onLaunchAtLoginChange(enabled),
      ),
    [onLaunchAtLoginChange, runAction],
  );

  const changeReduceMotion = useCallback<SettingsViewProps['onReduceMotionChange']>(
    (enabled) =>
      runAction('reduce-motion', 'Could not change Reduce motion. Try again.', () =>
        onReduceMotionChange(enabled),
      ),
    [onReduceMotionChange, runAction],
  );

  const visibleError = error ?? actionError;

  return (
    <div className="min-h-svh w-full bg-background text-foreground" data-testid="settings-view">
      <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col gap-8 px-8 py-10">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>

        <div className="grid gap-7">
          <div aria-label="Providers" className="grid gap-4" role="group">
            {(Object.keys(PROVIDER_LABEL) as Provider[]).map((provider) => (
              <div
                key={provider}
                aria-label={`${PROVIDER_LABEL[provider]} connection`}
                data-provider={provider}
                role="group"
              >
                <SettingRow label={PROVIDER_LABEL[provider]}>
                  <ProviderAction
                    isPending={isPending}
                    onConnect={connect}
                    onDisconnect={disconnect}
                    provider={provider}
                    state={providers[provider]}
                  />
                </SettingRow>
              </div>
            ))}
          </div>

          {visibleError === undefined ? null : (
            <p className="text-sm text-destructive" role="alert">
              {visibleError}
            </p>
          )}

          <div className="grid gap-4">
            <SettingRow label="Display">
              <Select
                disabled={displays.length === 0 || isPending('display')}
                onValueChange={(displayId) => void changeDisplay(displayId)}
                value={selectedDisplayId}
              >
                <SelectTrigger aria-label="Display" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {displays.map((display) => (
                    <SelectItem key={display.id} value={display.id}>
                      {display.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow htmlFor="launch-at-login" label="Launch at login">
              <Switch
                aria-label="Launch at login"
                checked={launchAtLogin}
                disabled={isPending('launch-at-login')}
                id="launch-at-login"
                onCheckedChange={(enabled) => void changeLaunchAtLogin(enabled)}
              />
            </SettingRow>
            <SettingRow htmlFor="reduce-motion" label="Reduce motion">
              <Switch
                aria-label="Reduce motion"
                checked={reduceMotion}
                disabled={isPending('reduce-motion')}
                id="reduce-motion"
                onCheckedChange={(enabled) => void changeReduceMotion(enabled)}
              />
            </SettingRow>
          </div>

          <Button
            aria-label="Open Advanced settings"
            className="h-9 w-full justify-between px-0"
            onClick={onOpenAdvanced}
            type="button"
            variant="ghost"
          >
            <span>Advanced</span>
            <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </main>
    </div>
  );
}

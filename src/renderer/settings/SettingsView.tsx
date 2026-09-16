import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { useCallback, useRef, useState, type ReactElement } from 'react';

import type {
  SettingsDisplayOption,
  SettingsConnectionKey,
  SettingsProviderConnectionStatus,
  SettingsProviderState,
} from '../../shared/settings';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
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

const CONNECTION_LABEL: Readonly<Record<SettingsConnectionKey, string>> = {
  codexDesktop: 'Codex Desktop',
  codexCli: 'Codex CLI',
  claudeCode: 'Claude Code',
};
const CONNECTION_KEYS: readonly SettingsConnectionKey[] = [
  'codexDesktop',
  'codexCli',
  'claudeCode',
];

export type ProviderConnectionStatus = SettingsProviderConnectionStatus;
export type { SettingsDisplayOption, SettingsProviderState };

export interface SettingsViewProps {
  providers: Readonly<Record<SettingsConnectionKey, SettingsProviderState>>;
  displays: readonly SettingsDisplayOption[];
  selectedDisplayId: string;
  launchAtLogin: boolean;
  reduceMotion: boolean;
  recentThreadLimit: number;
  error?: string;
  onConnect?: (connection: SettingsConnectionKey) => void | Promise<void>;
  onDisconnect?: (connection: SettingsConnectionKey) => void | Promise<void>;
  onDisplayChange: (displayId: string) => void | Promise<void>;
  onLaunchAtLoginChange: (enabled: boolean) => void | Promise<void>;
  onReduceMotionChange: (enabled: boolean) => void | Promise<void>;
  onRecentThreadLimitChange: (limit: number) => void | Promise<void>;
  onOpenAdvanced?: () => void;
  advancedDisabled?: boolean;
}

function ProviderAction({
  connection,
  state,
  isPending,
  canDisconnect,
  onConnect,
  onRequestDisconnect,
}: {
  connection: SettingsConnectionKey;
  state: SettingsProviderState;
  isPending: (action: SettingsAction) => boolean;
  canDisconnect: boolean;
  onConnect?: (connection: SettingsConnectionKey) => void | Promise<void>;
  onRequestDisconnect: (connection: SettingsConnectionKey) => void;
}): ReactElement {
  const label = CONNECTION_LABEL[connection];
  const isProviderPending = isPending(`provider:${connection}`);
  if (state.status === 'connected' || state.canDisconnect) {
    const statusLabel =
      state.status === 'connected'
        ? 'Connected'
        : state.status === 'connecting'
          ? 'Connecting…'
          : 'Unavailable';
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{statusLabel}</span>
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
              disabled={!state.canDisconnect || !canDisconnect || isProviderPending}
              onSelect={() => {
                if (state.canDisconnect && canDisconnect && !isProviderPending)
                  onRequestDisconnect(connection);
              }}
            >
              {isProviderPending ? 'Working…' : 'Disconnect'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  const isConnecting = state.status === 'connecting' || isProviderPending;
  return (
    <Button
      disabled={isConnecting || !state.canConnect || onConnect === undefined}
      onClick={() => {
        if (onConnect !== undefined) void onConnect(connection);
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {isConnecting ? 'Connecting…' : 'Connect'}
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
  | `provider:${SettingsConnectionKey}`
  | 'display'
  | 'launch-at-login'
  | 'reduce-motion'
  | 'recent-threads';

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
  recentThreadLimit,
  error,
  onConnect,
  onDisconnect,
  onDisplayChange,
  onLaunchAtLoginChange,
  onReduceMotionChange,
  onRecentThreadLimitChange,
  onOpenAdvanced,
  advancedDisabled = false,
}: SettingsViewProps): ReactElement {
  const pendingRef = useRef<Set<SettingsAction>>(new Set());
  const [pendingActions, setPendingActions] = useState<ReadonlySet<SettingsAction>>(new Set());
  const [actionError, setActionError] = useState<string>();
  const [disconnectTarget, setDisconnectTarget] = useState<SettingsConnectionKey>();

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

  const connect = useCallback(
    (connection: SettingsConnectionKey): void => {
      if (onConnect === undefined) return;
      runAction(
        `provider:${connection}`,
        `Could not connect to ${CONNECTION_LABEL[connection]}. Try again.`,
        () => onConnect(connection),
      );
    },
    [onConnect, runAction],
  );

  const disconnect = useCallback(
    (connection: SettingsConnectionKey): void => {
      if (onDisconnect === undefined) return;
      runAction(
        `provider:${connection}`,
        `Could not disconnect ${CONNECTION_LABEL[connection]}. Try again.`,
        () => onDisconnect(connection),
      );
    },
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

  const changeRecentThreadLimit = useCallback<SettingsViewProps['onRecentThreadLimitChange']>(
    (limit) =>
      runAction('recent-threads', 'Could not change Recent threads. Try again.', () =>
        onRecentThreadLimitChange(limit),
      ),
    [onRecentThreadLimitChange, runAction],
  );

  const visibleError = actionError ?? error;

  return (
    <div className="min-h-svh w-full bg-background text-foreground" data-testid="settings-view">
      <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col gap-8 px-8 py-10">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>

        <div className="grid gap-7">
          <div aria-label="Providers" className="grid gap-4" role="group">
            {CONNECTION_KEYS.map((connection) => (
              <div
                key={connection}
                aria-label={`${CONNECTION_LABEL[connection]} connection`}
                data-provider={connection}
                role="group"
              >
                <SettingRow label={CONNECTION_LABEL[connection]}>
                  <ProviderAction
                    isPending={isPending}
                    canDisconnect={onDisconnect !== undefined}
                    onConnect={onConnect === undefined ? undefined : connect}
                    onRequestDisconnect={setDisconnectTarget}
                    connection={connection}
                    state={providers[connection]}
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
            <SettingRow label="Recent threads">
              <Select
                disabled={isPending('recent-threads')}
                onValueChange={(value) => void changeRecentThreadLimit(Number(value))}
                value={String(recentThreadLimit)}
              >
                <SelectTrigger aria-label="Recent threads" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {Array.from({ length: 10 }, (_, index) => index + 1).map((limit) => (
                    <SelectItem key={limit} value={String(limit)}>
                      {limit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
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
            disabled={advancedDisabled || onOpenAdvanced === undefined}
            onClick={onOpenAdvanced}
            type="button"
            variant="ghost"
          >
            <span>Advanced</span>
            <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </main>

      <AlertDialog
        open={disconnectTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {disconnectTarget === undefined ? '' : CONNECTION_LABEL[disconnectTarget]}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Disconnect removes this app&apos;s local status history but does not change{' '}
              {disconnectTarget === 'claudeCode' ? 'Claude Code' : 'Codex'} data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                disconnectTarget === undefined ||
                isPending(`provider:${disconnectTarget}`) ||
                onDisconnect === undefined
              }
              onClick={() => {
                if (disconnectTarget !== undefined) disconnect(disconnectTarget);
              }}
              type="button"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import type { LoginItemSettings } from 'electron';

export interface LoginItemState {
  enabled: boolean;
  error?: string;
}

const APPROVAL_ERROR = 'Allow Agent Status Tiles in System Settings > General > Login Items.';

/** Project native login-item state without exposing platform diagnostics. */
export function evaluateLoginItemSettings(
  settings: LoginItemSettings,
  requestedEnabled?: boolean,
): LoginItemState {
  const enabled = settings.openAtLogin && settings.status === 'enabled';

  if (requestedEnabled === false && !settings.openAtLogin) {
    return { enabled: false };
  }
  if (settings.status === 'requires-approval') {
    return { enabled: false, error: APPROVAL_ERROR };
  }
  if (requestedEnabled === true && !enabled) {
    return { enabled: false, error: 'Launch at login could not be enabled. Try again.' };
  }
  if (requestedEnabled === false && settings.openAtLogin) {
    return { enabled, error: 'Launch at login could not be disabled. Try again.' };
  }
  return { enabled };
}

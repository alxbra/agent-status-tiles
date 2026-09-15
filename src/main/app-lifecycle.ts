/**
 * Coordinates app activation with the non-activating overlay.
 *
 * macOS may emit `activate` for the app.hide()/app.show() pair used to return
 * keyboard focus to the previous application. That activation is internal to
 * the overlay and must not open Settings. A short-lived suppression window is
 * used instead of a one-shot flag because Electron can report more than one
 * activation while the app is being shown.
 */
export const OVERLAY_ACTIVATION_SUPPRESSION_MS = 250;

export interface AppLifecycleController {
  handleActivate(): void;
  expectOverlayRestoreActivation(): void;
  destroy(): void;
}

export interface AppLifecycleOptions {
  recoverOverlay: () => void;
  openSettings: () => void;
  suppressionDurationMs?: number;
}

export function createAppLifecycleController(options: AppLifecycleOptions): AppLifecycleController {
  let suppressSettings = false;
  let suppressionTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const clearSuppression = (): void => {
    suppressSettings = false;
    if (suppressionTimer !== null) {
      clearTimeout(suppressionTimer);
      suppressionTimer = null;
    }
  };

  return {
    expectOverlayRestoreActivation: (): void => {
      if (destroyed) return;
      suppressSettings = true;
      if (suppressionTimer !== null) clearTimeout(suppressionTimer);
      suppressionTimer = setTimeout(
        clearSuppression,
        options.suppressionDurationMs ?? OVERLAY_ACTIVATION_SUPPRESSION_MS,
      );
    },
    handleActivate: (): void => {
      if (destroyed) return;
      options.recoverOverlay();
      if (suppressSettings) return;
      options.openSettings();
    },
    destroy: (): void => {
      if (destroyed) return;
      destroyed = true;
      clearSuppression();
    },
  };
}

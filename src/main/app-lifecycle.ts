/**
 * Coordinates app activation with the non-activating overlay.
 *
 * Electron's macOS app.show() unhides windows without focusing the app, so an
 * `activate` event remains a user/system activation and should open Settings.
 */
export interface AppLifecycleController {
  handleActivate(): void;
  destroy(): void;
}

export interface AppLifecycleOptions {
  recoverOverlay: () => void;
  openSettings: () => void;
}

export function createAppLifecycleController(options: AppLifecycleOptions): AppLifecycleController {
  let destroyed = false;

  return {
    handleActivate: (): void => {
      if (destroyed) return;
      options.recoverOverlay();
      options.openSettings();
    },
    destroy: (): void => {
      if (destroyed) return;
      destroyed = true;
    },
  };
}

import type { ElectronApplication, Page } from 'playwright';

export function findSettingsWindow(application: ElectronApplication): Page | undefined {
  return application.windows().find((window) => window.url().includes('/renderer/index.html'));
}

/**
 * Settings never opens by itself at launch; open it through a user activation.
 * The activation is re-sent while waiting because the app registers its
 * listener only once its runtime is ready, and a cold Electron launch can
 * take longer than the default expectation timeout.
 */
export async function settingsWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  let lastActivation = 0;

  while (Date.now() < deadline) {
    const existingSettingsWindow = findSettingsWindow(application);
    if (existingSettingsWindow) {
      return existingSettingsWindow;
    }
    if (Date.now() - lastActivation >= 250) {
      lastActivation = Date.now();
      await application.evaluate(({ app }) => {
        app.emit('activate');
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for the Settings window to load');
}

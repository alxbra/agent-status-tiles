import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';

/** Settings never opens by itself; keep activating until the runtime listens. */
export async function settingsWindow(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(async () => {
      const open = application
        .windows()
        .some((window) => window.url().includes('/renderer/index.html'));
      if (!open) {
        await application.evaluate(({ app }) => {
          app.emit('activate');
        });
      }
      return open;
    })
    .toBe(true);
  const settings = application
    .windows()
    .find((window) => window.url().includes('/renderer/index.html'));
  if (settings === undefined) throw new Error('Expected native Settings window');
  return settings;
}

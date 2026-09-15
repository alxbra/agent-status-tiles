import { expect, test, type Page } from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import { createServer, type ViteDevServer } from 'vite';

const projectRoot = process.cwd();
let fixtureServer: ViteDevServer;
let fixtureUrl: string;

test.beforeAll(async () => {
  fixtureServer = await createServer({
    configFile: false,
    plugins: [tailwindcss()],
    root: projectRoot,
    server: {
      fs: { allow: [projectRoot] },
      host: '127.0.0.1',
      port: 0,
    },
  });
  await fixtureServer.listen();
  const address = fixtureServer.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('Settings fixture server did not expose a TCP address');
  }
  fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/settings-view/index.html`;
});

test.afterAll(async () => {
  await fixtureServer?.close();
});

async function openFixture(page: Page, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.goto(`${fixtureUrl}?theme=${theme}`);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
}

test('renders the controlled settings fields with accessible names', async ({ page }) => {
  await openFixture(page);

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('[data-provider]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Connect' })).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: 'Display' })).toContainText('Primary');
  await expect(page.getByRole('switch', { name: 'Launch at login' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Reduce motion' })).not.toBeChecked();

  await page.getByRole('button', { name: 'Connect' }).first().click();
  await expect(page.locator('[data-provider="codex"]')).toContainText('Connected');
  await page.getByRole('button', { name: 'Actions for Codex' }).click();
  await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  await expect(page.getByRole('button', { name: 'Connect' }).first()).toBeVisible();

  const display = page.getByRole('combobox', { name: 'Display' });
  await display.focus();
  await page.keyboard.press('Enter');
  const builtInDisplay = page.getByRole('option', { name: 'Built-in Display' });
  await builtInDisplay.focus();
  await page.keyboard.press('Enter');
  await expect(display).toContainText('Built-in Display');

  const launchAtLogin = page.getByRole('switch', { name: 'Launch at login' });
  await launchAtLogin.focus();
  await page.keyboard.press('Space');
  await expect(launchAtLogin).toBeChecked();
  const reduceMotion = page.getByRole('switch', { name: 'Reduce motion' });
  await reduceMotion.focus();
  await page.keyboard.press('Space');
  await expect(reduceMotion).toBeChecked();

  await page.getByRole('button', { name: 'Open Advanced settings' }).press('Enter');
  await expect(page.getByTestId('advanced-opened')).toBeVisible();
});

test('keeps failed async changes visible without optimistic state', async ({ page }) => {
  await openFixture(page);

  await page.evaluate(() => {
    (
      window as Window & { __settingsFixture?: { rejectNextAction: () => void } }
    ).__settingsFixture?.rejectNextAction();
  });
  const reduceMotion = page.getByRole('switch', { name: 'Reduce motion' });
  await reduceMotion.click();
  await expect(page.getByRole('alert')).toHaveText('Could not change Reduce motion. Try again.');
  await expect(reduceMotion).not.toBeChecked();
});

for (const theme of ['light', 'dark'] as const) {
  test(`captures ${theme} settings presentation`, async ({ page }) => {
    await openFixture(page, theme);
    const screenshot = await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      fullPage: true,
      path: `test-results/settings-view/settings-${theme}.png`,
    });
    expect(screenshot.byteLength).toBeGreaterThan(0);
  });
}

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

test('serializes connect and disconnect operations for one provider', async ({ page }) => {
  await openFixture(page);

  await page.evaluate(() => {
    (
      window as Window & {
        __settingsFixture?: { deferNextAction: () => void };
      }
    ).__settingsFixture?.deferNextAction();
  });

  const codex = page.locator('[data-provider="codex"]');
  const codexConnect = codex.getByRole('button', { name: 'Connect' });
  await codexConnect.click();
  await expect(codex.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
  await codex.getByRole('button', { name: 'Connecting…' }).click({ force: true });
  expect(
    await page.evaluate(() =>
      (
        window as Window & {
          __settingsFixture?: { getProviderActionCalls: (provider: 'codex' | 'claude') => number };
        }
      ).__settingsFixture?.getProviderActionCalls('codex'),
    ),
  ).toBe(1);
  await expect(
    page.locator('[data-provider="claude"]').getByRole('button', { name: 'Connect' }),
  ).toBeEnabled();

  await page.evaluate(() => {
    (
      window as Window & {
        __settingsFixture?: { markProviderConnected: (provider: 'codex' | 'claude') => void };
      }
    ).__settingsFixture?.markProviderConnected('codex');
  });

  await codex.getByRole('button', { name: 'Actions for Codex' }).click();
  const disconnect = page.getByRole('menuitem');
  await expect(disconnect).toBeDisabled();

  await page.evaluate(() => {
    (
      window as Window & {
        __settingsFixture?: { resolveDeferredAction: () => void };
      }
    ).__settingsFixture?.resolveDeferredAction();
  });
  await expect(disconnect).toHaveText('Disconnect');
  await expect(disconnect).toBeEnabled();
  await disconnect.click();
  await expect(codex.getByRole('button', { name: 'Connect' })).toBeVisible();
});

for (const viewport of [
  { width: 420, height: 320 },
  { width: 320, height: 240 },
] as const) {
  test(`fits controls and reaches Advanced at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openFixture(page);

    await page.getByRole('combobox', { name: 'Display' }).click();
    await expect(page.getByRole('option', { name: 'Built-in Display' })).toBeVisible();
    await page.keyboard.press('Escape');

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    const advanced = page.getByRole('button', { name: 'Open Advanced settings' });
    await advanced.scrollIntoViewIfNeeded();
    await advanced.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('advanced-opened')).toBeVisible();

    const screenshot = await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      fullPage: true,
      path: `test-results/settings-view/settings-${viewport.width}x${viewport.height}.png`,
    });
    expect(screenshot.byteLength).toBeGreaterThan(0);
  });
}

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

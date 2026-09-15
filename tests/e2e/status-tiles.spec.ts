import { expect, test, type Page } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SessionSnapshot } from '../../src/shared/session';

const projectRoot = process.cwd();
let fixtureServer: ViteDevServer;

declare global {
  interface Window {
    __setFixtureSessions?: (sessions: readonly SessionSnapshot[]) => void;
    __fixtureOpenTarget?: { sessionId: string; completionId?: string };
    __fixtureDismissedSessionId?: string;
    __fixtureHitRegions?: unknown;
  }
}

test.beforeAll(async () => {
  fixtureServer = await createServer({
    root: projectRoot,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await fixtureServer.listen();
});

test.afterAll(async () => {
  await fixtureServer.close();
});

function fixtureUrl(query: string): string {
  const address = fixtureServer.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('The status tile fixture server did not start');
  }
  const { port } = address as AddressInfo;
  return `http://127.0.0.1:${String(port)}/tests/fixtures/status-tiles.html?${query}`;
}

function screenshotPath(count: number, state = 'collapsed'): string {
  return resolve(
    projectRoot,
    'test-results/status-tiles-screenshots',
    state === 'collapsed'
      ? `status-tiles-${String(count)}.png`
      : `status-tiles-${String(count)}-${state}.png`,
  );
}

async function openFixture(page: Page, count: number, suffix = ''): Promise<void> {
  await page.setViewportSize({ width: 180, height: 480 });
  await page.goto(fixtureUrl(`count=${String(count)}${suffix}`));
  await expect(page.locator('.status-tiles')).toBeVisible();
}

test.describe('rounded-square tile fixtures', () => {
  for (const count of [1, 12, 30]) {
    test(`renders the ${String(count)} session fixture with bounded targets`, async ({ page }) => {
      await openFixture(page, count);
      const expectedVisibleCount = Math.min(count, 12);
      const tiles = page.locator('.status-tiles__tile');
      await expect(tiles).toHaveCount(expectedVisibleCount);

      const metrics = await tiles.evaluateAll((elements) =>
        elements.map((element) => {
          const surface = element.querySelector('.status-tiles__tile-surface');
          const target = element.getBoundingClientRect();
          const visible = surface?.getBoundingClientRect();
          return {
            targetWidth: target.width,
            targetHeight: target.height,
            surfaceWidth: visible?.width,
            surfaceHeight: visible?.height,
            surfaceRadius: surface === null ? '' : getComputedStyle(surface).borderRadius,
          };
        }),
      );

      expect(
        metrics.every((metric) => metric.targetWidth === 24 && metric.targetHeight === 24),
      ).toBe(true);
      expect(
        metrics.every((metric) => metric.surfaceWidth === 10 && metric.surfaceHeight === 10),
      ).toBe(true);
      expect(metrics.every((metric) => metric.surfaceRadius === '3px')).toBe(true);
      await expect
        .poll(() => page.evaluate(() => Array.isArray(window.__fixtureHitRegions)))
        .toBe(true);

      await page.screenshot({ path: screenshotPath(count), animations: 'disabled' });
    });
  }
});

test('magnification survives a pointer sweep through transparent inter-tile gaps', async ({
  page,
}) => {
  await openFixture(page, 12);
  const root = page.locator('.status-tiles');
  const rootBox = await root.boundingBox();
  if (rootBox === null) throw new Error('Status tile strip has no bounds');

  const first = page.locator('.status-tiles__tile').first();
  const firstBox = await first.boundingBox();
  if (firstBox === null) throw new Error('First tile has no target box');
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await expect(first.locator('.status-tiles__tile-surface')).toHaveCSS('width', '40px');
  await page.screenshot({ path: screenshotPath(12, 'expanded'), animations: 'disabled' });

  const centers = await page.locator('.status-tiles__tile').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return box.y + box.height / 2;
    }),
  );

  const incoming = Array.from({ length: 11 }, (_, position) => {
    const index = 10 - position;
    return {
      id: `${index % 2 === 0 ? 'codex' : 'claude'}:fixture-${index}`,
      provider: index % 2 === 0 ? 'codex' : 'claude',
      surface: index % 2 === 0 ? 'desktop' : 'cli',
      title: `Fixture session ${index + 1}`,
      status: index === 0 ? 'error' : 'working',
      updatedAt: 100 + index,
      lastTurnStartedAt: 100 + index,
      completionId: index === 0 ? 'completion-2' : undefined,
      isTopLevel: true,
      isArchived: false,
      canOpen: true,
    } satisfies SessionSnapshot;
  });
  await page.evaluate((sessions) => window.__setFixtureSessions?.(sessions), incoming);

  // Membership/order remains frozen during interaction, while the full incoming
  // snapshot still updates the hovered tile's status.
  await expect(page.locator('.status-tiles__tile')).toHaveCount(12);
  await expect(page.locator('[data-session-id="codex:fixture-0"]')).toHaveAttribute(
    'data-status',
    'error',
  );

  const gapCenters = centers
    .slice(0, -1)
    .map((center, index) => (center + centers[index + 1]!) / 2);
  for (const gapY of gapCenters.slice(0, 4)) {
    // x=8 is in the strip's transparent left area, so the window/root pointer
    // forwarding path—not a tile target—keeps magnification alive.
    await page.mouse.move(rootBox.x + 8, rootBox.y + gapY);
    await expect
      .poll(async () =>
        page
          .locator('.status-tiles__tile-surface')
          .evaluateAll((elements) =>
            Math.max(...elements.map((element) => element.getBoundingClientRect().width)),
          ),
      )
      .toBeGreaterThan(10);
    await expect(page.locator('.status-tiles__tile')).toHaveCount(12);
    await expect(page.locator('[data-session-id="codex:fixture-0"]')).toHaveAttribute(
      'data-status',
      'error',
    );
  }

  await page.mouse.move(rootBox.x - 8, rootBox.y + rootBox.height / 2);
  await expect(page.locator('.status-tiles__tile')).toHaveCount(11);
  await expect(page.locator('.status-tiles__tile').first()).toHaveAttribute(
    'data-session-id',
    'codex:fixture-10',
  );
});

test('opens from the invisible part of a 24px target outside the colored surface', async ({
  page,
}) => {
  await openFixture(page, 1);
  const tile = page.locator('.status-tiles__tile');
  const target = await tile.boundingBox();
  const surface = await tile.locator('.status-tiles__tile-surface').boundingBox();
  if (target === null || surface === null) throw new Error('Tile target has no bounds');

  const clickX = target.x + target.width / 2 + 8;
  const clickY = target.y + target.height / 2;
  expect(clickX).toBeGreaterThan(surface.x + surface.width);
  expect(clickX).toBeLessThan(target.x + target.width);
  // Dispatch directly at the collapsed target so the pointer does not first
  // hover and move the target under the cursor before the click is pressed.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: clickX,
    y: clickY,
    button: 'left',
    clickCount: 1,
  });
  const expandedTarget = await tile.boundingBox();
  if (expandedTarget === null) throw new Error('Expanded tile target has no bounds');
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: expandedTarget.x + expandedTarget.width / 2,
    y: expandedTarget.y + expandedTarget.height / 2,
    button: 'left',
    clickCount: 1,
  });
  await expect
    .poll(() => page.evaluate(() => window.__fixtureOpenTarget?.sessionId))
    .toBe('codex:fixture-0');
});

test('keyboard navigation reaches sessions beyond the twelve-slot viewport', async ({ page }) => {
  await openFixture(page, 30);
  const first = page.locator('.status-tiles__tile').first();
  await first.focus();
  for (let index = 0; index < 13; index += 1) await page.keyboard.press('ArrowDown');

  await expect(page.locator('[data-session-id="claude:fixture-13"]')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('[data-session-id="codex:fixture-0"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.body.dataset.keyboardExit)).toBe('true');
});

test('reduced motion disables working animation while preserving keyboard focus expansion', async ({
  page,
}) => {
  await openFixture(page, 2, '&reduced=1');
  const root = page.locator('.status-tiles');
  await expect(root).toHaveClass(/status-tiles--reduced-motion/);
  const tile = page.locator('.status-tiles__tile[data-status="working"]');
  await tile.focus();
  await expect(tile.locator('.status-tiles__tile-surface')).toHaveCSS('width', '40px');
  await expect(tile.locator('.status-tiles__working-glyph')).toHaveCSS('animation-name', 'none');
});

test('captures the completion that was visible at pointer-down', async ({ page }) => {
  await openFixture(page, 1);
  const tile = page.locator('.status-tiles__tile');
  const box = await tile.boundingBox();
  if (box === null) throw new Error('Error tile has no target box');

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => {
    const current = {
      id: 'codex:fixture-0',
      provider: 'codex',
      surface: 'desktop',
      title: 'Fixture session 1',
      status: 'unread',
      updatedAt: 2,
      lastTurnStartedAt: 1,
      completionId: 'completion-2',
      isTopLevel: true,
      isArchived: false,
      canOpen: true,
    } as const;
    window.__setFixtureSessions?.([current]);
  });
  await page.waitForTimeout(50);
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__fixtureOpenTarget?.completionId))
    .toBe('completion-1');
});

test('waits for stock context-menu dismissal instead of dismissing on right-click', async ({
  page,
}) => {
  await openFixture(page, 1, '&error=1');

  await page.click('.status-tiles__tile', { button: 'right' });
  await expect(page.getByText('Dismiss error')).toBeVisible();
  expect(await page.evaluate(() => window.__fixtureDismissedSessionId)).toBeUndefined();
  await page.getByText('Dismiss error').click();
  await expect
    .poll(() => page.evaluate(() => window.__fixtureDismissedSessionId))
    .toBe('codex:fixture-0');
});

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

function visualScreenshotPath(name: string): string {
  return resolve(projectRoot, 'test-results/status-tiles-screenshots', `visual-${name}.png`);
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

async function sampleTransition(page: Page): Promise<
  readonly {
    targets: readonly { x: number; y: number; width: number; height: number }[];
    surfaces: readonly {
      left: number;
      right: number;
      top: number;
      bottom: number;
      width: number;
      icons: readonly { left: number; right: number; opacity: string; visibility: string }[];
    }[];
    rootRight: number;
  }[]
> {
  return page.evaluate(async () => {
    const root = document.querySelector<HTMLElement>('.status-tiles');
    if (root === null) throw new Error('Status tile strip has no bounds');
    const samples: {
      targets: readonly { x: number; y: number; width: number; height: number }[];
      surfaces: readonly {
        left: number;
        right: number;
        top: number;
        bottom: number;
        width: number;
        icons: readonly { left: number; right: number; opacity: string; visibility: string }[];
      }[];
      rootRight: number;
    }[] = [];
    const startedAt = performance.now();
    while (performance.now() - startedAt <= 220) {
      const rootBounds = root.getBoundingClientRect();
      samples.push({
        targets: [...root.querySelectorAll<HTMLElement>('.status-tiles__tile')].map((target) => {
          const bounds = target.getBoundingClientRect();
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        }),
        surfaces: [...root.querySelectorAll<HTMLElement>('.status-tiles__tile-surface')].map(
          (surface) => {
            const bounds = surface.getBoundingClientRect();
            return {
              left: bounds.left,
              right: bounds.right,
              top: bounds.top,
              bottom: bounds.bottom,
              width: bounds.width,
              icons: [...surface.querySelectorAll<HTMLElement>('[class*="-icon"]')].map((icon) => {
                const iconBounds = icon.getBoundingClientRect();
                const styles = getComputedStyle(icon);
                return {
                  left: iconBounds.left,
                  right: iconBounds.right,
                  opacity: styles.opacity,
                  visibility: styles.visibility,
                };
              }),
            };
          },
        ),
        rootRight: rootBounds.right,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return samples;
  });
}

function expectTransitionGeometry(
  samples: readonly {
    targets: readonly { x: number; y: number; width: number; height: number }[];
    surfaces: readonly {
      left: number;
      right: number;
      top: number;
      bottom: number;
      width: number;
      icons: readonly { left: number; right: number; opacity: string; visibility: string }[];
    }[];
    rootRight: number;
  }[],
): void {
  expect(samples.length).toBeGreaterThan(4);
  for (const sample of samples) {
    expect(sample.targets).toHaveLength(sample.surfaces.length);
    for (const [index, target] of sample.targets.entries()) {
      expect(target.width).toBeGreaterThanOrEqual(24);
      expect(target.height).toBeGreaterThanOrEqual(24);
      const surface = sample.surfaces[index]!;
      expect(target.x).toBeLessThanOrEqual(surface.left + 0.1);
      expect(target.x + target.width).toBeGreaterThanOrEqual(surface.right - 0.1);
      expect(target.y).toBeLessThanOrEqual(surface.top + 0.1);
      expect(target.y + target.height).toBeGreaterThanOrEqual(surface.bottom - 0.1);
      expect(target.width).toBeGreaterThanOrEqual(surface.width - 0.01);
      expect(target.height).toBeGreaterThanOrEqual(surface.bottom - surface.top - 0.01);
    }
    const surfaces = [...sample.surfaces].sort((left, right) => left.top - right.top);
    for (const [index, surface] of surfaces.entries()) {
      expect(Math.abs(surface.right - (sample.rootRight - 12))).toBeLessThan(0.1);
      const icons = surface.icons;
      expect(icons).toHaveLength(2);
      if (surface.width < 38) {
        expect(icons.every((icon) => icon.visibility === 'hidden')).toBe(true);
      } else {
        expect(icons.every((icon) => icon.visibility === 'visible')).toBe(true);
        expect(icons.every((icon) => Number(icon.opacity) >= 0)).toBe(true);
        expect(icons[0]!.right).toBeLessThanOrEqual(icons[1]!.left + 0.01);
      }
      if (index === 0) expect(surface.width).toBeGreaterThanOrEqual(10);
    }
    for (let index = 1; index < surfaces.length; index += 1) {
      expect(surfaces[index]!.top - surfaces[index - 1]!.bottom).toBeGreaterThanOrEqual(5.99);
    }
  }
}

test('animates anchored surfaces while hit targets and gaps stay valid', async ({ page }) => {
  await openFixture(page, 5);
  const root = page.locator('.status-tiles');
  const rootBox = await root.boundingBox();
  const first = page.locator('.status-tiles__tile').first();
  const initialTarget = await first.boundingBox();
  if (rootBox === null || initialTarget === null) throw new Error('Tile fixture has no bounds');

  await page.mouse.move(
    initialTarget.x + initialTarget.width / 2,
    initialTarget.y + initialTarget.height / 2,
  );
  expectTransitionGeometry(await sampleTransition(page));

  await page.mouse.move(rootBox.x - 8, rootBox.y + rootBox.height / 2);
  expectTransitionGeometry(await sampleTransition(page));
});

test('waits for enough expanded surface room before revealing both icons', async ({ page }) => {
  await openFixture(page, 2, '&visual=all');
  const first = page.locator('.status-tiles__tile').first();
  const second = page.locator('.status-tiles__tile').nth(1);
  const firstTarget = await first.boundingBox();
  const secondTarget = await second.boundingBox();
  if (firstTarget === null || secondTarget === null) throw new Error('Tile has no target box');

  await page.mouse.move(
    firstTarget.x + firstTarget.width / 2,
    firstTarget.y + firstTarget.height / 2 + 20,
  );
  await expect
    .poll(async () =>
      Number(
        await first
          .locator('.status-tiles__tile-surface')
          .evaluate((node) => node.getBoundingClientRect().width),
      ),
    )
    .toBeGreaterThanOrEqual(26);
  const intermediate = await first.locator('.status-tiles__tile-surface').evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    expanded: node.parentElement?.getAttribute('data-expanded'),
    providerIcons: node.querySelectorAll('.status-tiles__provider-icon').length,
    statusIcons: node.querySelectorAll('.status-tiles__status-icon').length,
    providerVisibility: getComputedStyle(node.querySelector('.status-tiles__provider-icon')!)
      .visibility,
    statusVisibility: getComputedStyle(node.querySelector('.status-tiles__status-icon')!)
      .visibility,
  }));
  expect(intermediate.width).toBeLessThan(38);
  expect(intermediate.expanded).toBe('false');
  expect(intermediate.providerIcons).toBe(1);
  expect(intermediate.statusIcons).toBe(1);
  expect(intermediate.providerVisibility).toBe('hidden');
  expect(intermediate.statusVisibility).toBe('hidden');

  await page.mouse.move(
    firstTarget.x + firstTarget.width / 2,
    firstTarget.y + firstTarget.height / 2,
  );
  await expect(first.locator('.status-tiles__tile-surface')).toHaveCSS('width', '40px');
  await expect(first.locator('.status-tiles__provider-icon')).toHaveCSS('opacity', '1');
  await expect(first.locator('.status-tiles__status-icon')).toHaveCSS('opacity', '1');

  await page.mouse.move(
    secondTarget.x + secondTarget.width / 2,
    secondTarget.y + secondTarget.height / 2,
  );
  await expect(second.locator('.status-tiles__tile-surface')).toHaveCSS('width', '40px');
  await expect(second.locator('.status-tiles__provider-icon')).toHaveCSS('opacity', '1');
  await expect(second).toHaveAttribute('data-provider', 'claude');
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

test('expanded surfaces remain owned by their session at edges and during motion', async ({
  page,
}) => {
  await openFixture(page, 5);
  const cdp = await page.context().newCDPSession(page);
  const first = page.locator('.status-tiles__tile').first();
  const firstTarget = await first.boundingBox();
  if (firstTarget === null) throw new Error('First tile has no target box');
  await page.mouse.move(
    firstTarget.x + firstTarget.width / 2,
    firstTarget.y + firstTarget.height / 2,
  );
  await expect(first.locator('.status-tiles__tile-surface')).toHaveCSS('width', '40px');

  async function clickAt(x: number, y: number, expectedSessionId: string): Promise<void> {
    await page.evaluate(() => {
      window.__fixtureOpenTarget = undefined;
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await expect
      .poll(() => page.evaluate(() => window.__fixtureOpenTarget?.sessionId))
      .toBe(expectedSessionId);
  }

  const expandedSurface = await first.locator('.status-tiles__tile-surface').boundingBox();
  if (expandedSurface === null) throw new Error('Expanded surface has no bounds');
  await clickAt(
    expandedSurface.x + 1,
    expandedSurface.y + expandedSurface.height / 2,
    'codex:fixture-0',
  );
  await clickAt(
    expandedSurface.x + expandedSurface.width / 2,
    expandedSurface.y + 1,
    'codex:fixture-0',
  );
  await clickAt(
    expandedSurface.x + expandedSurface.width / 2,
    expandedSurface.y + expandedSurface.height - 1,
    'codex:fixture-0',
  );

  const packedNeighbor = page.locator('.status-tiles__tile').nth(1);
  const packedNeighborSurface = await packedNeighbor
    .locator('.status-tiles__tile-surface')
    .boundingBox();
  if (packedNeighborSurface === null) throw new Error('Packed neighbor surface has no bounds');
  await clickAt(
    packedNeighborSurface.x + packedNeighborSurface.width / 2,
    packedNeighborSurface.y + packedNeighborSurface.height / 2,
    'claude:fixture-1',
  );

  await page.goto(fixtureUrl('count=5'));
  await expect(page.locator('.status-tiles')).toBeVisible();
  const animatedFirst = page.locator('.status-tiles__tile').first();
  const animatedTarget = await animatedFirst.boundingBox();
  if (animatedTarget === null) throw new Error('Animated tile has no target box');
  await page.mouse.move(
    animatedTarget.x + animatedTarget.width / 2,
    animatedTarget.y + animatedTarget.height / 2,
  );
  await page.waitForTimeout(40);
  const midMotionSurface = await animatedFirst.locator('.status-tiles__tile-surface').boundingBox();
  if (midMotionSurface === null) throw new Error('Mid-motion surface has no bounds');
  await clickAt(
    midMotionSurface.x + 1,
    midMotionSurface.y + midMotionSurface.height / 2,
    'codex:fixture-0',
  );
  await clickAt(
    midMotionSurface.x + midMotionSurface.width / 2,
    midMotionSurface.y + 1,
    'codex:fixture-0',
  );
  await clickAt(
    midMotionSurface.x + midMotionSurface.width / 2,
    midMotionSurface.y + midMotionSurface.height - 1,
    'codex:fixture-0',
  );
  const midMotionNeighbor = await page
    .locator('.status-tiles__tile')
    .nth(1)
    .locator('.status-tiles__tile-surface')
    .boundingBox();
  if (midMotionNeighbor === null) throw new Error('Mid-motion neighbor surface has no bounds');
  await clickAt(
    midMotionNeighbor.x + midMotionNeighbor.width / 2,
    midMotionNeighbor.y + midMotionNeighbor.height / 2,
    'claude:fixture-1',
  );
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

test('keyboard focus expands the selected tile while the pointer stays inside', async ({
  page,
}) => {
  await openFixture(page, 3);
  const first = page.locator('.status-tiles__tile').first();
  const firstTarget = await first.boundingBox();
  if (firstTarget === null) throw new Error('First tile has no target box');
  await page.mouse.move(
    firstTarget.x + firstTarget.width / 2,
    firstTarget.y + firstTarget.height / 2,
  );
  await first.focus();
  await page.keyboard.press('ArrowDown');
  const second = page.locator('.status-tiles__tile').nth(1);
  await expect(second).toBeFocused();
  await expect(second.locator('.status-tiles__tile-surface')).toHaveCSS('width', '40px');
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

test('respects emulated reduced motion when the component prop is false', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFixture(page, 2, '&reduced=0');
  await expect(page.locator('.status-tiles')).toHaveClass(/status-tiles--reduced-motion/);
  const workingTile = page.locator('.status-tiles__tile[data-status="working"]');
  await workingTile.focus();
  await expect(workingTile.locator('.status-tiles__working-glyph')).toHaveCSS(
    'animation-name',
    'none',
  );
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

async function captureVisualEvidence(page: Page, scaleLabel: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await openFixture(page, 6, `&visual=all&theme=${theme}`);
    const statuses = await page
      .locator('.status-tiles__tile')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-status')));
    expect(statuses).toEqual([
      'error',
      'unavailable',
      'working',
      'needs-input',
      'unread',
      'working',
    ]);
    await page.screenshot({
      path: visualScreenshotPath(`${scaleLabel}-${theme}-states`),
      scale: 'device',
      animations: 'disabled',
    });

    const errorTile = page.locator('.status-tiles__tile[data-status="error"]');
    const errorBox = await errorTile.boundingBox();
    if (errorBox === null) throw new Error('Error tile has no target box');
    await page.mouse.move(errorBox.x + errorBox.width / 2, errorBox.y + errorBox.height / 2);
    await expect(errorTile.locator('.status-tiles__tile-surface')).toHaveCSS('width', '40px');
    await expect(errorTile.locator('.status-tiles__provider-icon')).toHaveCSS('opacity', '1');
    await expect(errorTile.locator('.status-tiles__status-icon')).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: visualScreenshotPath(`${scaleLabel}-${theme}-error-expanded`),
      scale: 'device',
      animations: 'disabled',
    });

    await openFixture(page, 6, `&visual=all&theme=${theme}`);
    const unavailableTile = page.locator('.status-tiles__tile[data-status="unavailable"]');
    const unavailableBox = await unavailableTile.boundingBox();
    if (unavailableBox === null) throw new Error('Unavailable tile has no target box');
    await page.mouse.move(
      unavailableBox.x + unavailableBox.width / 2,
      unavailableBox.y + unavailableBox.height / 2,
    );
    await expect(unavailableTile.locator('.status-tiles__tile-surface')).toHaveCSS('width', '40px');
    await expect(unavailableTile.locator('.status-tiles__provider-icon')).toHaveCSS('opacity', '1');
    await expect(unavailableTile.locator('.status-tiles__status-icon')).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: visualScreenshotPath(`${scaleLabel}-${theme}-unavailable-expanded`),
      scale: 'device',
      animations: 'disabled',
    });

    for (const [provider, screenshotName] of [
      ['codex', 'openai-expanded'],
      ['claude', 'anthropic-expanded'],
    ] as const) {
      await openFixture(page, 2, `&visual=all&theme=${theme}`);
      const providerTile = page.locator(`.status-tiles__tile[data-provider="${provider}"]`);
      const providerBox = await providerTile.boundingBox();
      if (providerBox === null) throw new Error(`Missing ${provider} provider fixture tile`);
      await page.mouse.move(
        providerBox.x + providerBox.width / 2,
        providerBox.y + providerBox.height / 2,
      );
      await expect(providerTile.locator('.status-tiles__tile-surface')).toHaveCSS('width', '40px');
      await expect(providerTile.locator('.status-tiles__provider-icon')).toHaveCSS('opacity', '1');
      await expect(providerTile.locator('.status-tiles__status-icon')).toHaveCSS('opacity', '1');
      await page.screenshot({
        path: visualScreenshotPath(`${scaleLabel}-${theme}-${screenshotName}`),
        scale: 'device',
        animations: 'disabled',
      });
    }

    await openFixture(page, 30, `&theme=${theme}`);
    const nextIndicator = page.locator('.status-tiles__indicator--next');
    await expect(nextIndicator).toBeVisible();
    await expect(nextIndicator).toHaveCSS(
      'color',
      theme === 'dark' ? 'rgb(241, 241, 237)' : 'rgb(17, 19, 21)',
    );
    await page.screenshot({
      path: visualScreenshotPath(`${scaleLabel}-${theme}-overflow`),
      scale: 'device',
      animations: 'disabled',
    });
  }
}

for (const [scaleLabel, deviceScaleFactor] of [
  ['1x', 1],
  ['2x', 2],
] as const) {
  test.describe(`browser visual evidence at ${scaleLabel}`, () => {
    test.use({ deviceScaleFactor });

    test(`captures states, provider marks, overflow, and themes at ${scaleLabel}`, async ({
      page,
    }) => {
      await captureVisualEvidence(page, scaleLabel);
    });
  });
}

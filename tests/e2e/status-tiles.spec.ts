import { expect, test, type Locator, type Page } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SessionSnapshot } from '../../src/shared/session';
import {
  TAB_HEIGHT,
  TAB_HIT_MIN_WIDTH,
  TAB_PEEK_DOCK,
  TAB_PEEK_IDLE,
  visibleSlotCount,
} from '../../src/renderer/tiles/geometry';

const projectRoot = process.cwd();
const VIEWPORT = { width: 360, height: 480 };
let fixtureServer: ViteDevServer;

declare global {
  interface Window {
    __setFixtureSessions?: (sessions: readonly SessionSnapshot[]) => void;
    __setFixtureCount?: (count: number) => void;
    __triggerKeyboardEntry?: () => void;
    __fixtureOpenTarget?: { sessionId: string; completionId?: string };
    __fixtureDismissedSessionId?: string;
    __fixtureHitRegions?: unknown;
  }
}

interface FixtureHitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  sessionId: string;
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

function screenshotPath(count: number, state = 'folded'): string {
  return resolve(
    projectRoot,
    'test-results/status-tiles-screenshots',
    state === 'folded'
      ? `status-tiles-${String(count)}.png`
      : `status-tiles-${String(count)}-${state}.png`,
  );
}

function visualScreenshotPath(name: string): string {
  return resolve(projectRoot, 'test-results/status-tiles-screenshots', `visual-${name}.png`);
}

async function openFixture(page: Page, count: number, suffix = ''): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.goto(fixtureUrl(`count=${String(count)}${suffix}`));
  await expect(page.locator('.status-tiles')).toBeVisible();
}

/** On-screen width of every tab, in DOM order, rounded to a tenth of a pixel. */
async function visibleWidths(page: Page): Promise<number[]> {
  return page.locator('.status-tiles__tile').evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return Math.round((window.innerWidth - bounds.left) * 10) / 10;
    }),
  );
}

async function fullWidth(tab: Locator): Promise<number> {
  return tab.evaluate((element) => Math.round(element.getBoundingClientRect().width * 10) / 10);
}

/** Tabs are mostly off-screen, so hover the sliver instead of the element center. */
async function hoverTab(page: Page, tab: Locator): Promise<{ x: number; y: number }> {
  const box = await tab.boundingBox();
  if (box === null) throw new Error('Tab has no bounds');
  const point = { x: VIEWPORT.width - 6, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  return point;
}

async function hoverDockGutter(page: Page): Promise<void> {
  const box = await page.locator('.status-tiles__tile').first().boundingBox();
  if (box === null) throw new Error('First tab has no bounds');
  await page.mouse.move(VIEWPORT.width - 6, box.y - 6);
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(20, 20);
}

async function hitRegions(page: Page): Promise<FixtureHitRegion[]> {
  return page.evaluate(() => (window.__fixtureHitRegions ?? []) as FixtureHitRegion[]);
}

test.describe('folded tab fixtures', () => {
  for (const count of [1, 12, 30]) {
    test(`renders the ${String(count)} session fixture folded into the edge`, async ({ page }) => {
      await openFixture(page, count);
      const expectedVisibleCount = Math.min(count, 12);
      const tabs = page.locator('.status-tiles__tile');
      await expect(tabs).toHaveCount(expectedVisibleCount);

      const heights = await tabs.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height),
      );
      expect(heights.every((height) => height === TAB_HEIGHT)).toBe(true);
      await expect
        .poll(() => visibleWidths(page))
        .toEqual(Array.from({ length: expectedVisibleCount }, () => TAB_PEEK_IDLE));
      await expect(page.locator('.status-tiles__tile[data-extended="true"]')).toHaveCount(0);
      await expect(tabs.first().locator('.status-tiles__label')).toHaveText('Fixture session 1');

      await expect.poll(async () => (await hitRegions(page)).length).toBe(expectedVisibleCount);
      for (const region of await hitRegions(page)) {
        expect(region.width).toBeGreaterThanOrEqual(TAB_HIT_MIN_WIDTH);
        expect(region.x + region.width).toBeLessThanOrEqual(VIEWPORT.width);
        expect(region.height).toBe(TAB_HEIGHT);
      }

      await page.screenshot({ path: screenshotPath(count), animations: 'disabled' });
    });
  }
});

test('pulls every tab out to the icon depth while the pointer is near the edge', async ({
  page,
}) => {
  await openFixture(page, 3);
  await hoverDockGutter(page);
  await expect
    .poll(() => visibleWidths(page))
    .toEqual([TAB_PEEK_DOCK, TAB_PEEK_DOCK, TAB_PEEK_DOCK]);
  await expect(page.locator('.status-tiles')).toHaveClass(/status-tiles--active/);
  await expect(page.locator('.status-tiles__tile[data-extended="true"]')).toHaveCount(0);

  const iconMetrics = await page.locator('.status-tiles__tile').evaluateAll((elements) =>
    elements.map((element) => {
      const icon = element.querySelector('.status-tiles__provider-icon')!.getBoundingClientRect();
      const label = element.querySelector('.status-tiles__label')!.getBoundingClientRect();
      return {
        iconLeft: icon.left,
        iconRight: icon.right,
        labelLeft: label.left,
        width: window.innerWidth,
      };
    }),
  );
  for (const metric of iconMetrics) {
    expect(metric.iconLeft).toBeGreaterThanOrEqual(metric.width - TAB_PEEK_DOCK);
    expect(metric.iconRight).toBeLessThanOrEqual(metric.width);
    expect(metric.labelLeft).toBeGreaterThanOrEqual(metric.width - 0.5);
  }
  await expect
    .poll(async () => (await hitRegions(page)).map((region) => region.width))
    .toEqual([TAB_PEEK_DOCK, TAB_PEEK_DOCK, TAB_PEEK_DOCK]);

  await parkPointer(page);
  await expect
    .poll(() => visibleWidths(page))
    .toEqual([TAB_PEEK_IDLE, TAB_PEEK_IDLE, TAB_PEEK_IDLE]);
  await expect(page.locator('.status-tiles')).not.toHaveClass(/status-tiles--active/);
});

test('extends only the hovered tab and publishes its full width as the hit target', async ({
  page,
}) => {
  await openFixture(page, 3);
  const tabs = page.locator('.status-tiles__tile');
  const second = tabs.nth(1);
  const secondWidth = await fullWidth(second);

  await hoverTab(page, second);
  await expect(second).toHaveAttribute('data-extended', 'true');
  await expect.poll(() => visibleWidths(page)).toEqual([TAB_PEEK_DOCK, secondWidth, TAB_PEEK_DOCK]);
  const secondBox = await second.boundingBox();
  if (secondBox === null) throw new Error('Second tab has no bounds');
  expect(Math.abs(secondBox.x + secondBox.width - VIEWPORT.width)).toBeLessThan(0.5);
  await expect
    .poll(async () =>
      (await hitRegions(page)).map((region) => [
        region.sessionId,
        Math.round(region.width * 10) / 10,
      ]),
    )
    .toEqual([
      ['codex:fixture-0', TAB_PEEK_DOCK],
      ['claude:fixture-1', secondWidth],
      ['codex:fixture-2', TAB_PEEK_DOCK],
    ]);

  const first = tabs.first();
  await hoverTab(page, first);
  await expect(first).toHaveAttribute('data-extended', 'true');
  await expect(second).toHaveAttribute('data-extended', 'false');
  await expect
    .poll(() => visibleWidths(page))
    .toEqual([await fullWidth(first), TAB_PEEK_DOCK, TAB_PEEK_DOCK]);
});

test('keeps the dock open while moving between rows inside the reach zone', async ({ page }) => {
  await openFixture(page, 3);
  const tabs = page.locator('.status-tiles__tile');
  const boxes = await Promise.all([0, 1, 2].map((index) => tabs.nth(index).boundingBox()));
  if (boxes.some((box) => box === null)) throw new Error('Tabs have no bounds');
  const rows = boxes.map((box) => box!.y + box!.height / 2);
  const widths = await Promise.all([0, 1, 2].map((index) => fullWidth(tabs.nth(index))));
  // The reach depth is the widest tab's layout width (integer offsetWidth).
  const reach = Number(await page.locator('.status-tiles').getAttribute('data-reach-width'));
  expect(Math.abs(reach - Math.max(...widths))).toBeLessThanOrEqual(1);

  // Before anything is extended the gutter left of the edge strip is inert.
  await page.mouse.move(VIEWPORT.width - 150, rows[1]!);
  await expect(page.locator('.status-tiles')).not.toHaveClass(/status-tiles--active/);

  await hoverTab(page, tabs.nth(0));
  await expect(tabs.nth(0)).toHaveAttribute('data-extended', 'true');

  // Sliding straight down through the gutter hands the row to the next tab.
  await page.mouse.move(VIEWPORT.width - 150, rows[0]! + 8);
  await page.mouse.move(VIEWPORT.width - 150, rows[1]!);
  await expect(tabs.nth(1)).toHaveAttribute('data-extended', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('data-extended', 'false');
  await expect.poll(() => visibleWidths(page)).toEqual([TAB_PEEK_DOCK, widths[1], TAB_PEEK_DOCK]);

  // Toggling native passthrough reports a window leave while the cursor is
  // still inside the zone; that must not fold the dock.
  await page.evaluate(
    ([x, y]) => {
      document.documentElement.dispatchEvent(
        new PointerEvent('pointerleave', { clientX: x, clientY: y, bubbles: false }),
      );
    },
    [VIEWPORT.width - 150, rows[1]!] as const,
  );
  await page.waitForTimeout(100);
  await expect(tabs.nth(1)).toHaveAttribute('data-extended', 'true');

  // The margins above and below the stack belong to the edge tabs, so the
  // stack never retracts while the pointer stays inside the zone.
  await page.mouse.move(VIEWPORT.width - 150, boxes[0]!.y - 20);
  await expect(tabs.nth(0)).toHaveAttribute('data-extended', 'true');
  await expect(page.locator('.status-tiles')).toHaveClass(/status-tiles--active/);
  await page.mouse.move(VIEWPORT.width - 150, boxes[2]!.y + boxes[2]!.height + 20);
  await expect(tabs.nth(2)).toHaveAttribute('data-extended', 'true');
  await expect(page.locator('.status-tiles')).toHaveClass(/status-tiles--active/);
  await page.mouse.move(VIEWPORT.width - 150, rows[1]!);
  await expect(tabs.nth(1)).toHaveAttribute('data-extended', 'true');

  // The gap between rows belongs to the nearest tab instead of folding.
  await page.mouse.move(VIEWPORT.width - 150, boxes[2]!.y - 1);
  await expect(tabs.nth(2)).toHaveAttribute('data-extended', 'true');

  // Anywhere up to the widest tab keeps the dock; one pixel further folds it.
  await page.mouse.move(VIEWPORT.width - reach + 1, rows[2]!);
  await expect(tabs.nth(2)).toHaveAttribute('data-extended', 'true');
  await page.mouse.move(VIEWPORT.width - reach - 2, rows[2]!);
  await expect
    .poll(() => visibleWidths(page))
    .toEqual([TAB_PEEK_IDLE, TAB_PEEK_IDLE, TAB_PEEK_IDLE]);
  await expect(page.locator('.status-tiles')).not.toHaveClass(/status-tiles--active/);

  // Without a following move, a leave reported outside the zone folds the dock.
  await hoverTab(page, tabs.nth(0));
  await expect(tabs.nth(0)).toHaveAttribute('data-extended', 'true');
  await page.evaluate(() => {
    document.documentElement.dispatchEvent(
      new PointerEvent('pointerleave', { clientX: -10, clientY: -10, bubbles: false }),
    );
  });
  await expect
    .poll(() => visibleWidths(page))
    .toEqual([TAB_PEEK_IDLE, TAB_PEEK_IDLE, TAB_PEEK_IDLE]);
});

test('prefixes the thread name with the lab icon and suffixes the status mark', async ({
  page,
}) => {
  await openFixture(page, 2, '&visual=all');
  const structure = await page.locator('.status-tiles__tile').evaluateAll((elements) =>
    elements.map((element) => ({
      provider: element.getAttribute('data-provider'),
      children: [...element.children].map((child) =>
        child.classList.contains('status-tiles__provider-icon')
          ? `provider:${child.getAttribute('viewBox') ?? ''}`
          : child.classList.contains('status-tiles__label')
            ? `label:${child.textContent ?? ''}`
            : `status:${child.getAttribute('data-status-icon') ?? ''}`,
      ),
    })),
  );
  expect(structure).toEqual([
    {
      provider: 'codex',
      children: ['provider:0 0 256 260', 'label:Fixture session 1', 'status:error'],
    },
    {
      provider: 'claude',
      children: ['provider:0 0 256 176', 'label:Fixture session 2', 'status:unavailable'],
    },
  ]);
});

test('shows overflow cues and scrolls with vertical wheel input only', async ({ page }) => {
  await openFixture(page, 30);
  const root = page.locator('.status-tiles');
  await expect(page.locator('.status-tiles__indicator--next')).toBeVisible();
  await expect(page.locator('.status-tiles__indicator--previous')).toHaveCount(0);

  await hoverDockGutter(page);
  await root.dispatchEvent('wheel', { bubbles: true, cancelable: true, deltaX: 0, deltaY: 120 });
  await expect
    .poll(() => page.locator('.status-tiles__tile').first().getAttribute('data-session-id'))
    .not.toBe('codex:fixture-0');
  await expect(page.locator('.status-tiles__indicator--previous')).toBeVisible();
  const firstAfterVertical = await page
    .locator('.status-tiles__tile')
    .first()
    .getAttribute('data-session-id');

  await root.dispatchEvent('wheel', { bubbles: true, cancelable: true, deltaX: 80, deltaY: 0 });
  await root.dispatchEvent('wheel', { bubbles: true, cancelable: true, deltaX: 0, deltaY: 0 });
  await expect
    .poll(() => page.locator('.status-tiles__tile').first().getAttribute('data-session-id'))
    .toBe(firstAfterVertical);
});

test('measures the dock after empty mount, resize, and repopulation', async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(fixtureUrl('count=0'));
  await expect(page.locator('.status-tiles')).toHaveCount(0);

  await page.evaluate(() =>
    document.documentElement.style.setProperty('--fixture-height', '120px'),
  );
  await page.evaluate(() => window.__setFixtureCount?.(30));
  const root = page.locator('.status-tiles');
  await expect(root).toBeVisible();
  await expect(root.locator('.status-tiles__tile')).toHaveCount(visibleSlotCount(120));
  await expect.poll(async () => (await root.boundingBox())?.height).toBe(120);
  const shortMetrics = await root.locator('.status-tiles__tile').evaluateAll((elements) => {
    const rootBounds = document
      .querySelector<HTMLElement>('.status-tiles')!
      .getBoundingClientRect();
    return elements.map((element) => {
      const target = element.getBoundingClientRect();
      return { top: target.top - rootBounds.top, bottom: target.bottom - rootBounds.top };
    });
  });
  for (const metric of shortMetrics) {
    expect(metric.top).toBeGreaterThanOrEqual(-0.01);
    expect(metric.bottom).toBeLessThanOrEqual(120.01);
  }

  await page.evaluate(() => {
    document.documentElement.style.setProperty('--fixture-height', '480px');
  });
  await expect.poll(async () => (await root.boundingBox())?.height).toBe(480);
  await expect(root.locator('.status-tiles__tile')).toHaveCount(12);

  await page.evaluate(() => window.__setFixtureCount?.(0));
  await expect(root).toHaveCount(0);
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--fixture-height', '120px'),
  );
  await page.evaluate(() => window.__setFixtureCount?.(30));
  await expect(root).toBeVisible();
  await expect(root.locator('.status-tiles__tile')).toHaveCount(visibleSlotCount(120));
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

test('ignores focus that did not come from keyboard entry or navigation', async ({ page }) => {
  await openFixture(page, 3);
  const first = page.locator('.status-tiles__tile').first();
  await first.focus();
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('data-extended', 'false');
  await expect(first).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('.status-tiles')).not.toHaveClass(/status-tiles--active/);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.status-tiles__tile').nth(1)).toHaveAttribute('data-extended', 'true');
});

test('queued keyboard entry focuses the first visible tab after sessions appear', async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(fixtureUrl('count=0'));
  await expect(page.locator('.status-tiles')).toHaveCount(0);
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await page.evaluate(() => window.__setFixtureCount?.(3));
  await expect(page.locator('.status-tiles__tile').first()).toBeFocused();
  await expect(page.locator('.status-tiles__tile').first()).toHaveAttribute(
    'data-session-id',
    'codex:fixture-0',
  );
});

test('keyboard focus extends the focused tab and pulls the others to the icon depth', async ({
  page,
}) => {
  await openFixture(page, 3);
  const tabs = page.locator('.status-tiles__tile');
  await tabs.first().focus();
  await page.keyboard.press('ArrowDown');
  const second = tabs.nth(1);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('data-extended', 'true');
  await expect(page.locator('.status-tiles')).toHaveClass(/status-tiles--active/);
  await expect
    .poll(() => visibleWidths(page))
    .toEqual([TAB_PEEK_DOCK, await fullWidth(second), TAB_PEEK_DOCK]);
});

test('reduced motion disables the slide and working animations but keeps focus extension', async ({
  page,
}) => {
  await openFixture(page, 2, '&reduced=1');
  const root = page.locator('.status-tiles');
  await expect(root).toHaveClass(/status-tiles--reduced-motion/);
  const tab = page.locator('.status-tiles__tile[data-status="working"]');
  await expect(tab).toHaveCSS('transition-duration', '0s');
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await expect(page.locator('.status-tiles__tile').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tab).toBeFocused();
  await expect(tab).toHaveAttribute('data-extended', 'true');
  await expect.poll(async () => (await visibleWidths(page))[1]).toBe(await fullWidth(tab));
  await expect(tab.locator('.status-tiles__working-glyph')).toHaveCSS('animation-name', 'none');
});

test('respects emulated reduced motion when the component prop is false', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFixture(page, 2, '&reduced=0');
  await expect(page.locator('.status-tiles')).toHaveClass(/status-tiles--reduced-motion/);
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await expect(page.locator('.status-tiles__tile').first()).toBeFocused();
  await expect(page.locator('.status-tiles__tile').first()).toHaveAttribute(
    'data-extended',
    'true',
  );
  const workingTab = page.locator('.status-tiles__tile[data-status="working"]');
  await expect(workingTab.locator('.status-tiles__working-glyph')).toHaveCSS(
    'animation-name',
    'none',
  );
});

test('captures the completion that was visible at pointer-down', async ({ page }) => {
  await openFixture(page, 1);
  const tab = page.locator('.status-tiles__tile');
  await hoverTab(page, tab);
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
  const point = await hoverTab(page, page.locator('.status-tiles__tile'));
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(page.getByText('Dismiss error')).toBeVisible();
  expect(await page.evaluate(() => window.__fixtureDismissedSessionId)).toBeUndefined();
  await page.getByText('Dismiss error').click();
  await expect
    .poll(() => page.evaluate(() => window.__fixtureDismissedSessionId))
    .toBe('codex:fixture-0');
});

test('shows a bounded tooltip only when the tab label had to truncate the title', async ({
  page,
}) => {
  await openFixture(page, 1);
  const tab = page.locator('.status-tiles__tile');
  await hoverTab(page, tab);
  await expect(tab).toHaveAttribute('data-extended', 'true');
  await page.waitForTimeout(600);
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await parkPointer(page);

  const maximumTitle = 'T'.repeat(256);
  await page.evaluate((title) => {
    window.__setFixtureSessions?.([
      {
        id: 'codex:fixture-long-title',
        provider: 'codex',
        surface: 'desktop',
        title,
        status: 'working',
        updatedAt: 1,
        lastTurnStartedAt: 1,
        isTopLevel: true,
        isArchived: false,
        canOpen: true,
      },
    ]);
  }, maximumTitle);

  const longTab = page.getByRole('option', { name: `${maximumTitle}, OpenAI, working` });
  await expect(longTab.locator('.status-tiles__label')).toHaveCSS('max-width', '220px');
  await hoverTab(page, longTab);
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await expect(tooltip).toBeVisible();
  const bounds = await tooltip.boundingBox();
  if (bounds === null) throw new Error('Tooltip has no bounds');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(VIEWPORT.width);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(VIEWPORT.height);
  await expect(longTab).toHaveAccessibleName(`${maximumTitle}, OpenAI, working`);
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
      path: visualScreenshotPath(`${scaleLabel}-${theme}-folded`),
      scale: 'device',
      animations: 'disabled',
    });

    await hoverDockGutter(page);
    await expect.poll(() => visibleWidths(page)).toEqual(Array.from({ length: 6 }, () => 34));
    await page.screenshot({
      path: visualScreenshotPath(`${scaleLabel}-${theme}-dock-hover`),
      scale: 'device',
      animations: 'disabled',
    });

    for (const [status, screenshotName] of [
      ['error', 'error-extended'],
      ['needs-input', 'needs-input-extended'],
    ] as const) {
      const tab = page.locator(`.status-tiles__tile[data-status="${status}"]`);
      await hoverTab(page, tab);
      await expect(tab).toHaveAttribute('data-extended', 'true');
      await expect.poll(async () => (await hitRegions(page)).length).toBe(6);
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

    test(`captures folded, dock-hover, extended, overflow, and themes at ${scaleLabel}`, async ({
      page,
    }) => {
      await captureVisualEvidence(page, scaleLabel);
    });
  });
}

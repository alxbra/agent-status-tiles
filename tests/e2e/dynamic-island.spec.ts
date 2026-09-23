import { expect, test, type Page } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SessionSnapshot } from '../../src/shared/session';

const projectRoot = process.cwd();
/** Matches the native overlay window. */
const VIEWPORT = { width: 360, height: 56 };
let fixtureServer: ViteDevServer;

declare global {
  interface Window {
    __setIslandSessions?: (sessions: readonly SessionSnapshot[]) => void;
    __triggerKeyboardEntry?: () => void;
    __islandOpenTarget?: { sessionId: string; completionId?: string };
    __islandHitRegions?: unknown;
    __islandKeyboardExits?: number;
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

async function openIsland(page: Page, state: string, query = ''): Promise<void> {
  const address = fixtureServer.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('The island fixture server did not start');
  }
  const { port } = address as AddressInfo;
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    `http://127.0.0.1:${String(port)}/tests/fixtures/dynamic-island.html?state=${state}${query}`,
  );
  await expect(page.locator('.dynamic-island__pill')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

function screenshotPath(name: string): string {
  return resolve(projectRoot, 'test-results/dynamic-island-screenshots', `${name}.png`);
}

async function dotTones(page: Page): Promise<readonly (string | null)[]> {
  return page
    .locator('.dynamic-island__dot')
    .evaluateAll((dots) => dots.map((dot) => dot.getAttribute('data-tone')));
}

const CASES = [
  { state: 'idle', dots: ['idle'], label: null },
  { state: 'working', dots: ['working'], label: 'Codex is working' },
  { state: 'done', dots: ['unread'], label: 'Claude is done' },
  { state: 'working-done', dots: ['working', 'unread'], label: 'Claude is done' },
  { state: 'needs-input', dots: ['needs-input'], label: 'Codex needs input' },
] as const;

for (const { state, dots, label } of CASES) {
  test(`renders the compact ${state} island`, async ({ page }) => {
    await openIsland(page, state);
    expect(await dotTones(page)).toEqual(dots);
    const labelLocator = page.locator('.dynamic-island__label');
    if (label === null) {
      await expect(labelLocator).toHaveCount(0);
      await expect(page.locator('.dynamic-island__pill')).toHaveAttribute(
        'aria-label',
        'All threads are idle',
      );
    } else {
      await expect(labelLocator).toHaveText(label);
      await expect(page.locator('.dynamic-island__pill')).toHaveAttribute('aria-label', label);
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: screenshotPath(state), animations: 'disabled' });
  });
}

test('uses the fixed status palette and a Fira Code label', async ({ page }) => {
  await openIsland(page, 'needs-input');
  expect(await page.evaluate(() => document.fonts.check('500 12px "Fira Code"'))).toBe(true);
  const colors = async (): Promise<readonly string[]> =>
    page
      .locator('.dynamic-island__dot')
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).backgroundColor),
      );
  expect(await colors()).toEqual(['rgb(255, 138, 61)']);
  await page.evaluate(() => {
    window.__setIslandSessions?.([
      {
        id: 'codex:w',
        provider: 'codex',
        surface: 'desktop',
        title: 'W',
        status: 'working',
        updatedAt: 2,
        lastTurnStartedAt: 2,
        isTopLevel: true,
        isArchived: false,
        canOpen: true,
      },
      {
        id: 'claude:d',
        provider: 'claude',
        surface: 'cli',
        title: 'D',
        status: 'unread',
        completionId: 'done-1',
        updatedAt: 1,
        lastTurnStartedAt: 1,
        isTopLevel: true,
        isArchived: false,
        canOpen: true,
      },
    ]);
  });
  await expect(page.locator('.dynamic-island__dot')).toHaveCount(2);
  expect(await colors()).toEqual(['rgb(141, 206, 245)', 'rgb(143, 234, 152)']);
});

test('pulses only blue dots and stills them under reduced motion', async ({ page }) => {
  await openIsland(page, 'working-done');
  const animations = async (): Promise<readonly string[]> =>
    page
      .locator('.dynamic-island__dot')
      .evaluateAll((dots) => dots.map((dot) => getComputedStyle(dot).animationName));
  const [blue, green] = await animations();
  expect(blue).toContain('dynamic-island-breathe');
  expect(green).not.toContain('dynamic-island-breathe');

  await openIsland(page, 'working-done', '&motion=reduced');
  expect(await animations()).toEqual(['none', 'none']);
  expect(
    await page
      .locator('.dynamic-island__shape')
      .evaluate((shape) => getComputedStyle(shape).transitionProperty),
  ).toBe('none');
});

test('resizes the island around its label and publishes the pill as the only hit region', async ({
  page,
}) => {
  await openIsland(page, 'idle');
  const pill = page.locator('.dynamic-island__pill');
  const idleBox = await pill.boundingBox();
  expect(idleBox?.width).toBe(48);
  expect(idleBox?.height).toBe(32);
  expect(idleBox?.y).toBe(0);

  await page.evaluate(() => {
    window.__setIslandSessions?.([
      {
        id: 'codex:w',
        provider: 'codex',
        surface: 'desktop',
        title: 'W',
        status: 'working',
        updatedAt: 2,
        lastTurnStartedAt: 2,
        isTopLevel: true,
        isArchived: false,
        canOpen: true,
      },
    ]);
  });
  await expect(page.locator('.dynamic-island__label')).toHaveText('Codex is working');
  await expect
    .poll(async () => {
      const box = await pill.boundingBox();
      const regions = (await page.evaluate(() => window.__islandHitRegions)) as
        readonly { x: number; y: number; width: number; height: number }[] | undefined;
      if (box === null || regions === undefined) return null;
      return {
        wider: box.width > 120,
        centered: Math.round(box.x + box.width / 2) === VIEWPORT.width / 2,
        regionCount: regions.length,
        matchesPill:
          Math.abs((regions[0]?.x ?? -1) - box.x) < 0.5 &&
          Math.abs((regions[0]?.width ?? -1) - box.width) < 0.5 &&
          regions[0]?.y === 0 &&
          regions[0]?.height === 32,
      };
    })
    .toEqual({ wider: true, centered: true, regionCount: 1, matchesPill: true });
});

test('opens the labeled thread with the completion visible at pointer-down', async ({ page }) => {
  await openIsland(page, 'working-done');
  await page.locator('.dynamic-island__pill').click();
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({
    sessionId: 'claude:b',
    completionId: 'completion-b',
  });
});

test('does nothing when an idle island is clicked', async ({ page }) => {
  await openIsland(page, 'idle');
  const pill = page.locator('.dynamic-island__pill');
  await expect(pill).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled keeps the idle island out of Playwright's actionability checks.
  await pill.click({ force: true });
  expect(await page.evaluate(() => window.__islandOpenTarget)).toBeUndefined();
});

test('takes keyboard focus from the menu bar entry and leaves it on Escape', async ({ page }) => {
  await openIsland(page, 'needs-input');
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  const pill = page.locator('.dynamic-island__pill');
  await expect(pill).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({
    sessionId: 'codex:c',
  });
  await pill.focus();
  await page.keyboard.press('Escape');
  await expect(pill).not.toBeFocused();
  expect(await page.evaluate(() => window.__islandKeyboardExits)).toBe(1);
});

test('renders nothing without visible sessions', async ({ page }) => {
  await openIsland(page, 'idle');
  await page.evaluate(() => window.__setIslandSessions?.([]));
  await expect(page.locator('.dynamic-island')).toHaveCount(0);
});

function workingSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'codex:w',
    provider: 'codex',
    surface: 'desktop',
    title: 'W',
    status: 'working',
    updatedAt: 2,
    lastTurnStartedAt: 2,
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
    ...overrides,
  };
}

test('focuses the island once a keyboard entry that arrived early can land', async ({ page }) => {
  await openIsland(page, 'idle');
  await page.evaluate(() => window.__setIslandSessions?.([]));
  await expect(page.locator('.dynamic-island')).toHaveCount(0);
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await page.evaluate((session) => window.__setIslandSessions?.([session]), workingSession());
  await expect(page.locator('.dynamic-island__pill')).toBeFocused();
});

test('leaves keyboard mode on Escape even when the pill lost focus', async ({ page }) => {
  await openIsland(page, 'working');
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await expect(page.locator('.dynamic-island__pill')).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__islandKeyboardExits)).toBe(1);
});

test('never opens a thread that cannot be opened', async ({ page }) => {
  await openIsland(page, 'idle');
  await page.evaluate(
    (session) => window.__setIslandSessions?.([session]),
    workingSession({ canOpen: false }),
  );
  const pill = page.locator('.dynamic-island__pill');
  await expect(pill).toHaveAttribute('aria-disabled', 'true');
  await pill.click({ force: true });
  await pill.focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__islandOpenTarget)).toBeUndefined();
});

test('ignores a stale right-click capture when Enter opens the island', async ({ page }) => {
  await openIsland(page, 'working-done');
  const pill = page.locator('.dynamic-island__pill');
  await pill.click({ button: 'right' });
  await page.evaluate(
    (session) => window.__setIslandSessions?.([session]),
    workingSession({ id: 'claude:later', provider: 'claude' }),
  );
  await expect(page.locator('.dynamic-island__label')).toHaveText('Claude is working');
  await pill.focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({
    sessionId: 'claude:later',
  });
});

test('republishes the hit region when the window width changes', async ({ page }) => {
  await openIsland(page, 'working');
  const offset = async (): Promise<number | null> => {
    const box = await page.locator('.dynamic-island__pill').boundingBox();
    const x = await page.evaluate(
      () => (window.__islandHitRegions as readonly { x: number }[] | undefined)?.[0]?.x,
    );
    return box === null || x === undefined ? null : Math.round(Math.abs(x - box.x) * 10) / 10;
  };
  await expect.poll(offset).toBe(0);
  await page.setViewportSize({ width: VIEWPORT.width + 100, height: VIEWPORT.height });
  const pillCenter = async (): Promise<number | null> => {
    const box = await page.locator('.dynamic-island__pill').boundingBox();
    return box === null ? null : Math.round(box.x + box.width / 2);
  };
  await expect.poll(pillCenter).toBe((VIEWPORT.width + 100) / 2);
  await expect.poll(offset).toBe(0);
});

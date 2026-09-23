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
    __islandTurnsFinished?: number;
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

async function columns(page: Page): Promise<readonly string[]> {
  return page
    .locator('.dynamic-island__harness')
    .evaluateAll((cells) =>
      cells.map(
        (cell) =>
          `${cell.querySelector('.dynamic-island__name')?.textContent ?? ''}:${cell.getAttribute('data-tone') ?? ''}`,
      ),
    );
}

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

const CASES = [
  { state: 'idle', columns: ['Codex:idle', 'Claude:idle'], label: 'Codex idle, Claude idle' },
  // A done thread reads as idle.
  {
    state: 'working',
    columns: ['Codex:working', 'Claude:idle'],
    label: 'Codex working, Claude idle',
  },
  {
    state: 'both-working',
    columns: ['Codex:working', 'Claude:working'],
    label: 'Codex working, Claude working',
  },
  {
    state: 'needs-input',
    columns: ['Codex:needs-input', 'Claude:idle'],
    label: 'Codex needs input, Claude idle',
  },
  {
    state: 'mixed',
    columns: ['Codex:working', 'Claude:needs-input'],
    label: 'Codex working, Claude needs input',
  },
] as const;

for (const { state, columns: expected, label } of CASES) {
  test(`renders the ${state} harness columns`, async ({ page }) => {
    await openIsland(page, state);
    expect(await columns(page)).toEqual(expected);
    await expect(page.locator('.dynamic-island__pill')).toHaveAttribute('aria-label', label);
    await page.waitForTimeout(500);
    await page.screenshot({ path: screenshotPath(state), animations: 'disabled' });
  });
}

test('mirrors Codex on the left and Claude on the right in one gray', async ({ page }) => {
  await openIsland(page, 'mixed');
  expect(await page.evaluate(() => document.fonts.check('500 12px "Fira Code"'))).toBe(true);
  const layout = await page.locator('.dynamic-island__harness').evaluateAll((cells) =>
    cells.map((cell) => ({
      side: cell.getAttribute('data-side'),
      order: [...cell.children].map((child) => child.className),
    })),
  );
  expect(layout).toEqual([
    { side: 'start', order: ['dynamic-island__dot', 'dynamic-island__name'] },
    { side: 'end', order: ['dynamic-island__name', 'dynamic-island__dot'] },
  ]);
  const colors = await page
    .locator('.dynamic-island__name')
    .evaluateAll((names) => names.map((name) => getComputedStyle(name).color));
  expect(colors).toEqual(['rgba(241, 241, 237, 0.62)', 'rgba(241, 241, 237, 0.62)']);
  const dots = await page
    .locator('.dynamic-island__dot')
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).backgroundColor),
    );
  expect(dots).toEqual(['rgb(141, 206, 245)', 'rgb(255, 138, 61)']);
});

test('pulses only working dots and stills them under reduced motion', async ({ page }) => {
  await openIsland(page, 'working');
  const animations = async (): Promise<readonly string[]> =>
    page
      .locator('.dynamic-island__dot')
      .evaluateAll((dots) => dots.map((dot) => getComputedStyle(dot).animationName));
  const [codex, claude] = await animations();
  expect(codex).toContain('dynamic-island-breathe');
  expect(claude).not.toContain('dynamic-island-breathe');

  await openIsland(page, 'working', '&motion=reduced');
  expect(await animations()).toEqual(['none', 'none']);
  expect(
    await page
      .locator('.dynamic-island__shape')
      .evaluate((shape) => getComputedStyle(shape).transitionProperty),
  ).toBe('none');
});

test('cues a finished turn, pulsing green only while the harness still works', async ({ page }) => {
  await page.clock.install();
  await openIsland(page, 'idle');
  const codexA = workingSession({ id: 'codex:a' });
  const codexB = workingSession({ id: 'codex:b', updatedAt: 3 });
  const claudeC = workingSession({ id: 'claude:c', provider: 'claude', surface: 'cli' });
  const doneA = workingSession({ id: 'codex:a', status: 'unread', completionId: 'done-a' });
  const doneC = workingSession({
    id: 'claude:c',
    provider: 'claude',
    surface: 'cli',
    status: 'unread',
    completionId: 'done-c',
  });
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [codexA, codexB, claudeC],
  );
  await expect.poll(() => columns(page)).toEqual(['Codex:working', 'Claude:working']);
  expect(await page.evaluate(() => window.__islandTurnsFinished)).toBeUndefined();

  // Codex finishes one thread while another still runs: green for five seconds.
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [doneA, codexB, claudeC],
  );
  await expect.poll(() => columns(page)).toEqual(['Codex:finished', 'Claude:working']);
  expect(await page.evaluate(() => window.__islandTurnsFinished)).toBe(1);
  expect(
    await page
      .locator('.dynamic-island__harness[data-provider="codex"] .dynamic-island__dot')
      .evaluate((dot) => getComputedStyle(dot).backgroundColor),
  ).toBe('rgb(143, 234, 152)');
  await page.clock.runFor(4_900);
  expect(await columns(page)).toEqual(['Codex:finished', 'Claude:working']);
  await page.clock.runFor(200);
  await expect.poll(() => columns(page)).toEqual(['Codex:working', 'Claude:working']);

  // Claude finishes its only thread: the cue sounds, and it is simply idle.
  await page.evaluate((sessions) => window.__setIslandSessions?.(sessions), [doneA, codexB, doneC]);
  await expect.poll(() => columns(page)).toEqual(['Codex:working', 'Claude:idle']);
  expect(await page.evaluate(() => window.__islandTurnsFinished)).toBe(2);
});

test('does not cue completions that already existed when the island opened', async ({ page }) => {
  await openIsland(page, 'working');
  await page.evaluate(() => window.__setIslandSessions?.([]));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__islandTurnsFinished)).toBeUndefined();
});

test('publishes the pill as the only hit region, centered at the top', async ({ page }) => {
  await openIsland(page, 'working');
  const pill = page.locator('.dynamic-island__pill');
  await expect
    .poll(async () => {
      const box = await pill.boundingBox();
      const regions = (await page.evaluate(() => window.__islandHitRegions)) as
        readonly { x: number; y: number; width: number; height: number }[] | undefined;
      if (box === null || regions === undefined) return null;
      return {
        top: box.y,
        height: box.height,
        centered: Math.round(box.x + box.width / 2) === VIEWPORT.width / 2,
        regionCount: regions.length,
        matchesPill:
          Math.abs((regions[0]?.x ?? -1) - box.x) < 0.5 &&
          Math.abs((regions[0]?.width ?? -1) - box.width) < 0.5,
      };
    })
    .toEqual({ top: 0, height: 32, centered: true, regionCount: 1, matchesPill: true });
});

test('opens the thread shown at pointer-down', async ({ page }) => {
  await openIsland(page, 'working');
  const box = await page.locator('.dynamic-island__pill').boundingBox();
  if (box === null) throw new Error('The island has no bounds');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Another thread starts waiting for input between pointer-down and click.
  await page.evaluate(
    (session) => window.__setIslandSessions?.([session]),
    workingSession({ id: 'claude:later', provider: 'claude', status: 'needs-input', updatedAt: 9 }),
  );
  await expect.poll(() => columns(page)).toEqual(['Codex:idle', 'Claude:needs-input']);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({ sessionId: 'codex:a' });
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
  // A thread waiting for input is the most urgent one to open.
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

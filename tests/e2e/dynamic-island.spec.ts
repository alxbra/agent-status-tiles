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

// The native overlay runs with this autoplay policy and never takes focus.
test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

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

function fixtureUrl(state: string, query = ''): string {
  const address = fixtureServer.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('The island fixture server did not start');
  }
  const { port } = address as AddressInfo;
  return `http://127.0.0.1:${String(port)}/tests/fixtures/dynamic-island.html?state=${state}${query}`;
}

async function openIsland(page: Page, state: string, query = ''): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.goto(fixtureUrl(state, query));
  await expect(page.locator('.dynamic-island__pill')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // Let the width spring settle so pointer tests aim at columns that stay put.
  await expect
    .poll(() =>
      page
        .locator('.dynamic-island__shape')
        .evaluate((shape) => getComputedStyle(shape).width === (shape as HTMLElement).style.width),
    )
    .toBe(true);
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

function column(page: Page, provider: 'codex' | 'claude') {
  return page.locator(`.dynamic-island__harness[data-provider="${provider}"]`);
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
  // A done thread reads as idle, and idle harnesses are hidden.
  { state: 'working', columns: ['Codex:working'], label: 'Codex working' },
  { state: 'claude-only', columns: ['Claude:working'], label: 'Claude working' },
  {
    state: 'both-working',
    columns: ['Codex:working', 'Claude:working'],
    label: 'Codex working, Claude working',
  },
  { state: 'needs-input', columns: ['Codex:needs-input'], label: 'Codex needs input' },
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
    const labels = await page
      .locator('.dynamic-island__harness')
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label')));
    expect(labels.join(', ')).toBe(label);
    await page.waitForTimeout(500);
    await page.screenshot({ path: screenshotPath(state), animations: 'disabled' });
  });
}

test('mirrors Codex on the left and Claude on the right, each name in its dot color', async ({
  page,
}) => {
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
  expect(colors).toEqual(['rgb(141, 206, 245)', 'rgb(255, 138, 61)']);
  const dots = await page
    .locator('.dynamic-island__dot')
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).backgroundColor),
    );
  expect(dots).toEqual(['rgb(141, 206, 245)', 'rgb(255, 138, 61)']);
});

test('pulses only working dots and stills them under reduced motion', async ({ page }) => {
  await openIsland(page, 'mixed');
  const animations = async (): Promise<readonly string[]> =>
    page
      .locator('.dynamic-island__dot')
      .evaluateAll((dots) => dots.map((dot) => getComputedStyle(dot).animationName));
  const [codex, claude] = await animations();
  expect(codex).toContain('dynamic-island-breathe');
  expect(claude).not.toContain('dynamic-island-breathe');

  await openIsland(page, 'mixed', '&motion=reduced');
  expect(await animations()).toEqual(['none', 'none']);
  expect(
    await page
      .locator('.dynamic-island__shape')
      .evaluate((shape) => getComputedStyle(shape).transitionProperty),
  ).toBe('none');
});

test('cues every finished turn with ten seconds of green, then the current tone', async ({
  page,
}) => {
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

  // Codex finishes one thread while another still runs: green for ten seconds.
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
  // Codex finishes a second thread after 6 s: the green restarts from there.
  await page.clock.runFor(6_000);
  const codexD = workingSession({ id: 'codex:d', updatedAt: 4 });
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [doneA, codexB, codexD, claudeC],
  );
  await expect.poll(() => columns(page)).toEqual(['Codex:finished', 'Claude:working']);
  const doneD = workingSession({ id: 'codex:d', status: 'unread', completionId: 'done-d' });
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [doneA, codexB, doneD, claudeC],
  );
  await expect.poll(() => page.evaluate(() => window.__islandTurnsFinished)).toBe(2);
  await page.clock.runFor(9_900);
  expect(await columns(page)).toEqual(['Codex:finished', 'Claude:working']);
  await page.clock.runFor(200);
  await expect.poll(() => columns(page)).toEqual(['Codex:working', 'Claude:working']);

  // Claude finishes its only thread: green for ten seconds, then idle and hidden.
  await page.evaluate((sessions) => window.__setIslandSessions?.(sessions), [doneA, codexB, doneC]);
  await expect.poll(() => columns(page)).toEqual(['Codex:working', 'Claude:finished']);
  expect(await page.evaluate(() => window.__islandTurnsFinished)).toBe(3);
  expect(
    await column(page, 'claude')
      .locator('.dynamic-island__name')
      .evaluate((name) => getComputedStyle(name).color),
  ).toBe('rgb(143, 234, 152)');
  await page.clock.runFor(10_100);
  await expect.poll(() => columns(page)).toEqual(['Codex:working']);

  // Once the tone moves away, the green is over for good: a question and its
  // answer inside the ten seconds bring back blue, not green.
  const againA = workingSession({ id: 'codex:a', status: 'unread', completionId: 'done-a3' });
  const askingB = workingSession({ id: 'codex:b', updatedAt: 3, status: 'needs-input' });
  const set = (sessions: readonly SessionSnapshot[]): Promise<void> =>
    page.evaluate((next) => window.__setIslandSessions?.(next), sessions);
  await set([againA, codexB, doneC]);
  await expect.poll(() => columns(page)).toEqual(['Codex:finished']);
  expect(await page.evaluate(() => window.__islandTurnsFinished)).toBe(4);
  await set([againA, askingB, doneC]);
  await expect.poll(() => columns(page)).toEqual(['Codex:needs-input']);
  await set([againA, codexB, doneC]);
  await expect.poll(() => columns(page)).toEqual(['Codex:working']);

  // A question outranks the cue: Codex finishes a turn while another of its
  // threads waits for input, so it sounds but stays orange.
  const onceMoreA = workingSession({ id: 'codex:a', status: 'unread', completionId: 'done-a4' });
  await set([againA, askingB, doneC]);
  await expect.poll(() => columns(page)).toEqual(['Codex:needs-input']);
  await set([onceMoreA, askingB, doneC]);
  await expect.poll(() => page.evaluate(() => window.__islandTurnsFinished)).toBe(5);
  expect(await columns(page)).toEqual(['Codex:needs-input']);
});

test('does not cue completions that already existed or re-cue on a re-render', async ({ page }) => {
  await openIsland(page, 'working');
  // The same sessions again, as new objects, must not count as a finished turn.
  await page.evaluate(() => {
    const current = [
      {
        id: 'codex:a',
        provider: 'codex',
        surface: 'desktop',
        title: 'Fixture a',
        status: 'working',
        updatedAt: 3,
        lastTurnStartedAt: 3,
        isTopLevel: true,
        isArchived: false,
        canOpen: true,
      },
      {
        id: 'claude:b',
        provider: 'claude',
        surface: 'cli',
        title: 'Fixture b',
        status: 'unread',
        completionId: 'completion-b',
        updatedAt: 2,
        lastTurnStartedAt: 2,
        isTopLevel: true,
        isArchived: false,
        canOpen: true,
      },
    ] as const;
    window.__setIslandSessions?.(current.map((session) => ({ ...session })));
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__islandTurnsFinished)).toBeUndefined();
  expect(await columns(page)).toEqual(['Codex:working']);
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

test("opens each column's own harness thread", async ({ page }) => {
  await openIsland(page, 'mixed');
  await column(page, 'codex').click();
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({ sessionId: 'codex:a' });
  await column(page, 'claude').click();
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({ sessionId: 'claude:b' });
});

test('opens the thread shown at pointer-down', async ({ page }) => {
  await openIsland(page, 'working');
  const box = await column(page, 'codex').boundingBox();
  if (box === null) throw new Error('The Codex column has no bounds');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Another Codex thread starts waiting for input between pointer-down and click.
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [
      workingSession({ id: 'codex:a' }),
      workingSession({ id: 'codex:later', status: 'needs-input', updatedAt: 9 }),
    ],
  );
  await expect.poll(() => columns(page)).toEqual(['Codex:needs-input']);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({ sessionId: 'codex:a' });
});

test('opens the just-finished thread while its green cue shows', async ({ page }) => {
  await openIsland(page, 'idle');
  const running = [
    workingSession({ id: 'codex:a' }),
    workingSession({ id: 'codex:b', updatedAt: 3 }),
  ];
  await page.evaluate((sessions) => window.__setIslandSessions?.(sessions), running);
  await expect.poll(() => columns(page)).toEqual(['Codex:working']);
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [
      workingSession({ id: 'codex:a', status: 'unread', completionId: 'done-a' }),
      workingSession({ id: 'codex:b', updatedAt: 3 }),
    ],
  );
  await expect.poll(() => columns(page)).toEqual(['Codex:finished']);
  await column(page, 'codex').click();
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({
    sessionId: 'codex:a',
    completionId: 'done-a',
  });
});

test('hides idle harnesses and sleeps when none is active', async ({ page }) => {
  await openIsland(page, 'idle');
  await expect(page.locator('.dynamic-island__harness')).toHaveCount(0);
  const sleeper = page.getByRole('img', { name: 'All agents idle' });
  await expect(sleeper).toBeVisible();
  // The sleeping island is still the one hit region, and clicking it opens nothing.
  expect(await page.evaluate(() => window.__islandHitRegions)).toHaveLength(1);
  await page.locator('.dynamic-island__pill').click();
  expect(await page.evaluate(() => window.__islandOpenTarget)).toBeUndefined();
  const animations = (): Promise<readonly string[]> =>
    page
      .locator(
        '.dynamic-island__sleeper-sprite, .dynamic-island__sleeper-frame, .dynamic-island__sleeper-twitch, .dynamic-island__z',
      )
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).animationName),
      );
  expect(await animations()).toEqual([
    'dynamic-island-sleep-breathe',
    'dynamic-island-sleep-rest',
    'dynamic-island-sleep-twitch',
    'dynamic-island-z',
    'dynamic-island-z',
  ]);
  await page.screenshot({ path: screenshotPath('idle'), animations: 'disabled' });

  // A harness that starts working wakes the island.
  await page.evaluate((session) => window.__setIslandSessions?.([session]), workingSession());
  await expect.poll(() => columns(page)).toEqual(['Codex:working']);
  await expect(sleeper).toHaveCount(0);

  // Under reduced motion the frenchie rests still: the twitch never shows.
  await openIsland(page, 'idle', '&motion=reduced');
  expect(await animations()).toEqual(['none', 'none', 'none', 'none', 'none']);
  expect(
    await page
      .locator('.dynamic-island__sleeper-twitch')
      .evaluate((twitch) => getComputedStyle(twitch).visibility),
  ).toBe('hidden');
});

test('shows a different frenchie each time the island falls asleep', async ({ page }) => {
  await openIsland(page, 'idle');
  const pose = (): Promise<string | null> =>
    page.locator('.dynamic-island__sleeper').getAttribute('data-pose');
  const names = ['head-on-paws', 'curled-up', 'belly-up', 'donut-bed', 'sploot'];
  let previous = await pose();
  expect(names).toContain(previous);
  const seen = new Set([previous]);
  for (let nap = 0; nap < 12; nap += 1) {
    await page.evaluate((session) => window.__setIslandSessions?.([session]), workingSession());
    await expect.poll(() => columns(page)).toEqual(['Codex:working']);
    await page.evaluate(
      (session) => window.__setIslandSessions?.([session]),
      workingSession({ status: 'idle' }),
    );
    await expect(page.locator('.dynamic-island__sleeper')).toBeVisible();
    const next = await pose();
    expect(names).toContain(next);
    expect(next).not.toBe(previous);
    seen.add(next);
    previous = next;
  }
  expect(seen.size).toBeGreaterThan(1);

  // Reappearing idle after the island hid without sessions is a new nap too.
  await page.evaluate(() => window.__setIslandSessions?.([]));
  await expect(page.locator('.dynamic-island')).toHaveCount(0);
  await page.evaluate(
    (session) => window.__setIslandSessions?.([session]),
    workingSession({ status: 'idle' }),
  );
  await expect(page.locator('.dynamic-island__sleeper')).toBeVisible();
  expect(await pose()).not.toBe(previous);
});

test('draws every frenchie pose inside the island', async ({ page }) => {
  await page.setViewportSize({ width: VIEWPORT.width, height: 360 });
  await page.goto(fixtureUrl('sleepers'));
  const poses = page.locator('.dynamic-island__sleeper');
  await expect(poses).toHaveCount(5);
  // Every pose fits the island's 24 px content height.
  const heights = await page
    .locator('.dynamic-island__sleeper-sprite')
    .evaluateAll((sprites) => sprites.map((sprite) => sprite.getBoundingClientRect().height));
  expect(heights.every((height) => height <= 24)).toBe(true);
  await page.screenshot({ path: screenshotPath('sleepers'), animations: 'disabled' });
});

test('takes keyboard focus from the menu bar entry and leaves it on Escape', async ({ page }) => {
  await openIsland(page, 'mixed');
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  // Focus lands on the harness waiting for input.
  const claude = column(page, 'claude');
  await expect(claude).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({ sessionId: 'claude:b' });
  await page.keyboard.press('Shift+Tab');
  await expect(column(page, 'codex')).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__islandOpenTarget)).toEqual({ sessionId: 'codex:a' });
  await page.keyboard.press('Escape');
  await expect(column(page, 'codex')).not.toBeFocused();
  expect(await page.evaluate(() => window.__islandKeyboardExits)).toBe(1);
});

test('lands keyboard entry on a column that can open, then on the newest thread', async ({
  page,
}) => {
  await openIsland(page, 'idle');
  // Codex's only thread cannot open, so both working columns rank by openability.
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [
      workingSession({ id: 'codex:locked', canOpen: false, updatedAt: 9 }),
      workingSession({ id: 'claude:open', provider: 'claude', updatedAt: 1 }),
    ],
  );
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await expect(column(page, 'claude')).toBeFocused();

  // Both can open and both are working: the harness with the newer thread wins.
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [
      workingSession({ id: 'codex:new', updatedAt: 9 }),
      workingSession({ id: 'claude:old', provider: 'claude', updatedAt: 1 }),
    ],
  );
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await expect(column(page, 'codex')).toBeFocused();
});

test('ends keyboard mode at once when the island is asleep', async ({ page }) => {
  await openIsland(page, 'idle');
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await expect.poll(() => page.evaluate(() => window.__islandKeyboardExits)).toBe(1);
  // The entry is spent: a harness waking later does not take focus.
  await page.evaluate((session) => window.__setIslandSessions?.([session]), workingSession());
  await expect.poll(() => columns(page)).toEqual(['Codex:working']);
  await expect(column(page, 'codex')).not.toBeFocused();
});

test('keeps keyboard focus on the island when a focused column hides', async ({ page }) => {
  await openIsland(page, 'mixed');
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await expect(column(page, 'claude')).toBeFocused();
  // Claude's question is answered and it goes idle: focus moves to Codex.
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [
      workingSession({ id: 'codex:a', updatedAt: 5 }),
      workingSession({ id: 'claude:b', provider: 'claude', status: 'idle', updatedAt: 4 }),
    ],
  );
  await expect(column(page, 'codex')).toBeFocused();
  expect(await page.evaluate(() => window.__islandKeyboardExits)).toBeUndefined();
  // Codex goes idle too: the island sleeps and keyboard mode ends.
  await page.evaluate(
    (sessions) => window.__setIslandSessions?.(sessions),
    [
      workingSession({ id: 'codex:a', status: 'idle', updatedAt: 5 }),
      workingSession({ id: 'claude:b', provider: 'claude', status: 'idle', updatedAt: 4 }),
    ],
  );
  await expect.poll(() => page.evaluate(() => window.__islandKeyboardExits)).toBe(1);
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
  await expect(column(page, 'codex')).toBeFocused();
});

test('leaves keyboard mode on Escape even when the column lost focus', async ({ page }) => {
  await openIsland(page, 'working');
  await page.evaluate(() => window.__triggerKeyboardEntry?.());
  await expect(column(page, 'codex')).toBeFocused();
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
  const codex = column(page, 'codex');
  await expect(codex).toHaveAttribute('aria-disabled', 'true');
  await codex.click({ force: true });
  await codex.focus();
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

test.describe('the success cue', () => {
  test('synthesizes its three tones without any user gesture', async ({ page }) => {
    await page.addInitScript(() => {
      // Playwright's evaluate counts as a user gesture, so record the audio
      // state at load, before any evaluate: under the overlay's autoplay
      // policy it must already run without one.
      const probe = new AudioContext();
      Reflect.set(window, '__audioStateAtLoad', probe.state);
      void probe.close();
      // Also report no activation, so a reintroduced JavaScript gesture check fails.
      Object.defineProperty(Navigator.prototype, 'userActivation', {
        configurable: true,
        get: () => ({ hasBeenActive: false, isActive: false }),
      });
      const created: number[] = [];
      Reflect.set(window, '__oscillators', created);
      const original = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function createOscillator(this: AudioContext) {
        created.push(this.currentTime);
        return original.call(this);
      };
    });
    await openIsland(page, 'working', '&sound=real');
    expect(await page.evaluate(() => Reflect.get(window, '__audioStateAtLoad'))).toBe('running');
    expect(await page.evaluate(() => navigator.userActivation.hasBeenActive)).toBe(false);
    await page.evaluate(
      (session) => window.__setIslandSessions?.([session]),
      workingSession({ id: 'codex:a', status: 'unread', completionId: 'done-a' }),
    );
    await expect
      .poll(() => page.evaluate(() => (Reflect.get(window, '__oscillators') as number[]).length))
      .toBe(3);
  });
});

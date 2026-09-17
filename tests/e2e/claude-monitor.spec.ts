import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeHookJournalBaseName } from '../../src/main/providers/hooks/hook-journal-reader';
import {
  createInitialMonitoringState,
  loadSessionState,
  saveSessionState,
} from '../../src/main/sessions/persistence';
import { nativeElectronE2eEnabled } from './native-focus';

test.beforeEach(() => {
  test.skip(!nativeElectronE2eEnabled(), 'Native Electron tests may take focus; opt in explicitly');
});

const projectRoot = process.cwd();
const mainEntry = resolve(projectRoot, 'out/main/index.js');
const desktopId = 'aaaaaaaa-1111-4111-8111-111111111111';
const cliId = 'bbbbbbbb-2222-4222-8222-222222222222';
const endedId = 'cccccccc-3333-4333-8333-333333333333';
const linkedId = 'dddddddd-4444-4444-8444-444444444444';
const abandonedId = 'eeeeeeee-5555-4555-8555-555555555555';
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1_000;
const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1_000;
let clock = 1_789_000_000_000;

/** A helper-shaped journal record; the helper never journals prompts or paths. */
function record(
  sessionId: string,
  eventName: string,
  overrides: Record<string, unknown> = {},
): string {
  clock += 1;
  return `${JSON.stringify({
    schema_version: 1,
    provider: 'claude',
    event_name: eventName,
    session_id: sessionId,
    timestamp: clock,
    project_name: sessionId === desktopId ? 'desktop-project' : 'cli-project',
    project_id: 'c'.repeat(64),
    host: sessionId === desktopId ? 'claude-desktop' : 'ghostty',
    ...overrides,
  })}\n`;
}

function journalPath(userDataDir: string, sessionId: string, suffix = ''): string {
  return join(
    userDataDir,
    'journals',
    'claude',
    `${makeHookJournalBaseName('claude', sessionId)}.jsonl${suffix}`,
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** A session whose journal and archive were last written `ageMs` ago, ended or not. */
async function seedOldJournal(
  userDataDir: string,
  sessionId: string,
  options: { ended: boolean; ageMs: number },
): Promise<void> {
  const stamp = new Date(Date.now() - options.ageMs);
  const records = (...names: string[]): string =>
    names
      .map((name) => record(sessionId, name, { host: 'terminal', project_name: 'old-project' }))
      .join('');
  await writeFile(journalPath(userDataDir, sessionId, '.1'), records('SessionStart', 'Stop'));
  await utimes(journalPath(userDataDir, sessionId, '.1'), stamp, stamp);
  await writeFile(
    journalPath(userDataDir, sessionId),
    options.ended ? records('Stop', 'SessionEnd') : records('UserPromptSubmit', 'Stop'),
  );
  await utimes(journalPath(userDataDir, sessionId), stamp, stamp);
}

async function overlayWindow(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(() =>
      application.windows().some((window) => window.url().includes('/renderer/overlay.html')),
    )
    .toBe(true);
  const overlay = application
    .windows()
    .find((window) => window.url().includes('/renderer/overlay.html'));
  if (overlay === undefined) throw new Error('Expected native overlay');
  return overlay;
}

async function sessions(
  overlay: Page,
): Promise<{ id: string; status: string; surface: string; title: string }[]> {
  return overlay.evaluate(async () =>
    (await window.agentStatusTilesOverlay.getState()).sessions.map((session) => ({
      id: session.id,
      status: session.status,
      surface: session.surface,
      title: session.title,
    })),
  );
}

/** Tile order between near-simultaneous sessions is the reducer's business, not this test's. */
async function statusByTitle(overlay: Page): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await sessions(overlay)).map((session) => [session.title, session.status]),
  );
}

test('native Claude Desktop and CLI journals baseline idle, publish live status, and prune on end', async () => {
  test.skip(process.platform !== 'darwin', 'native overlay targets macOS');
  const root = await mkdtemp(join(tmpdir(), 'agent-status-tiles-claude-e2e-'));
  const userDataDir = join(root, 'user-data');
  let application: ElectronApplication | undefined;
  try {
    await mkdir(join(userDataDir, 'journals', 'claude'), { recursive: true, mode: 0o700 });
    await writeFile(
      journalPath(userDataDir, desktopId),
      record(desktopId, 'SessionStart', { session_source: 'startup' }) +
        record(desktopId, 'UserPromptSubmit') +
        record(desktopId, 'Stop'),
    );
    await writeFile(
      journalPath(userDataDir, cliId),
      record(cliId, 'SessionStart', { session_source: 'startup' }) +
        record(cliId, 'UserPromptSubmit'),
    );
    // Journal collection: an ended journal past retention goes with its
    // archive, as does one that never ended but has been silent for a month;
    // a set containing a symlink stays, and the link's target is never touched.
    await seedOldJournal(userDataDir, endedId, { ended: true, ageMs: EIGHT_DAYS_MS });
    await seedOldJournal(userDataDir, abandonedId, { ended: false, ageMs: THIRTY_ONE_DAYS_MS });
    await seedOldJournal(userDataDir, linkedId, { ended: true, ageMs: EIGHT_DAYS_MS });
    const outside = join(root, 'outside.jsonl');
    await writeFile(outside, 'not a journal\n');
    await symlink(outside, journalPath(userDataDir, linkedId, '.2'));
    const monitoring = createInitialMonitoringState();
    monitoring.partitions['claude:desktop'].enabled = true;
    monitoring.partitions['claude:cli'].enabled = true;
    await saveSessionState(userDataDir, monitoring);
    const launchOptions = {
      args: [`--user-data-dir=${userDataDir}`, mainEntry],
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'test' },
    };
    application = await electron.launch(launchOptions);
    const overlay = await overlayWindow(application);
    for (const key of ['claude:desktop', 'claude:cli'] as const) {
      await expect
        .poll(
          async () =>
            (await loadSessionState(userDataDir)).monitoring.partitions[key].baseline.status,
        )
        .toBe('ready');
    }
    // Historical work lands idle (the completed Desktop turn) or keeps its
    // last state (the CLI turn still working) and is attributed per surface.
    await expect
      .poll(async () =>
        (await sessions(overlay)).sort((left, right) => left.id.localeCompare(right.id)),
      )
      .toEqual([
        { id: `claude:${desktopId}`, status: 'idle', surface: 'desktop', title: 'desktop-project' },
        { id: `claude:${cliId}`, status: 'working', surface: 'cli', title: 'cli-project' },
      ]);
    const persisted = await loadSessionState(userDataDir);
    expect(persisted.monitoring.owners[`claude:${desktopId}`]).toBe('claude:desktop');
    expect(persisted.monitoring.owners[`claude:${cliId}`]).toBe('claude:cli');
    expect(JSON.stringify(persisted.monitoring)).not.toContain(root);

    // The first discovery pass swept the ended journal and its archive, and
    // only that: the linked set, its target, and the live journals remain.
    await expect.poll(() => exists(journalPath(userDataDir, endedId))).toBe(false);
    expect(await exists(journalPath(userDataDir, endedId, '.1'))).toBe(false);
    await expect.poll(() => exists(journalPath(userDataDir, abandonedId))).toBe(false);
    expect(await exists(journalPath(userDataDir, abandonedId, '.1'))).toBe(false);
    expect(await exists(journalPath(userDataDir, linkedId))).toBe(true);
    expect(await exists(journalPath(userDataDir, linkedId, '.1'))).toBe(true);
    expect(await exists(journalPath(userDataDir, linkedId, '.2'))).toBe(true);
    expect(await exists(outside)).toBe(true);
    expect(await exists(journalPath(userDataDir, desktopId))).toBe(true);
    expect(await exists(journalPath(userDataDir, cliId))).toBe(true);

    // Live status arrives from appended records within the file poll.
    await appendFile(journalPath(userDataDir, desktopId), record(desktopId, 'UserPromptSubmit'));
    await expect
      .poll(() => statusByTitle(overlay))
      .toEqual({
        'desktop-project': 'working',
        'cli-project': 'working',
      });
    await appendFile(
      journalPath(userDataDir, desktopId),
      record(desktopId, 'PermissionRequest', { tool_call_id: 'call-1' }),
    );
    await expect
      .poll(async () => (await statusByTitle(overlay))['desktop-project'])
      .toBe('needs-input');
    await appendFile(
      journalPath(userDataDir, desktopId),
      record(desktopId, 'PostToolUse', { tool_call_id: 'call-1' }) + record(desktopId, 'Stop'),
    );
    await expect.poll(async () => (await statusByTitle(overlay))['desktop-project']).toBe('unread');
    await appendFile(journalPath(userDataDir, cliId), record(cliId, 'StopFailure'));
    await expect.poll(async () => (await statusByTitle(overlay))['cli-project']).toBe('error');

    // A restart replays from persisted cursors without a duplicate completion.
    await application.close();
    application = await electron.launch(launchOptions);
    const restarted = await overlayWindow(application);
    await expect
      .poll(() => statusByTitle(restarted))
      .toEqual({
        'desktop-project': 'unread',
        'cli-project': 'error',
      });

    // An ended session leaves the cohort on the next discovery.
    await appendFile(
      journalPath(userDataDir, desktopId),
      record(desktopId, 'SessionEnd', { end_reason: 'other' }),
    );
    await expect
      .poll(async () => (await sessions(restarted)).map((session) => session.title))
      .toEqual(['cli-project']);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

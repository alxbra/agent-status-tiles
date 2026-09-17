import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function journalPath(userDataDir: string, sessionId: string): string {
  return join(
    userDataDir,
    'journals',
    'claude',
    `${makeHookJournalBaseName('claude', sessionId)}.jsonl`,
  );
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

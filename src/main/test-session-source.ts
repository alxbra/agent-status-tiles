import type { SessionSnapshot, SessionStatus } from '../shared/session';

export const TEST_SESSION_COUNT_FLAG = '--agent-status-tiles-test-session-count=';
export const MAX_TEST_SESSION_COUNT = 30;

const TEST_STATUSES: readonly SessionStatus[] = ['working', 'needs-input', 'unread', 'error'];

/** Read only the explicitly bounded fixture argument, and only in test mode. */
export function parseTestSessionCount(
  argv: readonly string[] = process.argv,
  nodeEnvironment: string | undefined = process.env.NODE_ENV,
): number {
  if (nodeEnvironment !== 'test') return 0;
  const argument = argv.find((value) => value.startsWith(TEST_SESSION_COUNT_FLAG));
  if (argument === undefined) return 0;
  const rawCount = argument.slice(TEST_SESSION_COUNT_FLAG.length);
  if (!/^(?:0|[1-9]\d*)$/.test(rawCount)) return 0;
  const count = Number(rawCount);
  return Number.isSafeInteger(count) && count >= 0 && count <= MAX_TEST_SESSION_COUNT ? count : 0;
}

/** Deterministic metadata-only snapshots used by bounded Electron tests. */
export function createTestSessionSnapshots(count: number): readonly SessionSnapshot[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_TEST_SESSION_COUNT) return [];

  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    const provider = index % 2 === 0 ? 'codex' : 'claude';
    const status = TEST_STATUSES[index % TEST_STATUSES.length]!;
    return {
      id: `${provider}:test-session-${sequence}`,
      provider,
      surface: provider === 'codex' ? 'desktop' : 'cli',
      title: `Test session ${sequence}`,
      status,
      updatedAt: sequence,
      lastTurnStartedAt: sequence,
      ...(status === 'unread' ? { completionId: `test-completion-${sequence}` } : {}),
      isTopLevel: true,
      isArchived: false,
      canOpen: true,
    } satisfies SessionSnapshot;
  });
}

export function createStartupOverlayState(): {
  sessions: readonly SessionSnapshot[];
  reducedMotion: boolean;
} {
  const count = parseTestSessionCount();
  return {
    sessions: createTestSessionSnapshots(count),
    reducedMotion: false,
  };
}

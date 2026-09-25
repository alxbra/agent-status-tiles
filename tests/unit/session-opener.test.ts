import { describe, expect, it, vi } from 'vitest';

import {
  navigationTarget,
  openIslandSession,
  type SessionOpenerOptions,
} from '../../src/main/navigation/session-opener';
import type { NavigationResult } from '../../src/main/navigation/macos-navigator';
import type { SessionSnapshot } from '../../src/shared/session';

const CODEX_ID = '0199f6a1-2b3c-7d4e-8f90-123456789abc';

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: `codex:${CODEX_ID}`,
    provider: 'codex',
    surface: 'desktop',
    title: 'One',
    status: 'working',
    updatedAt: 1,
    lastTurnStartedAt: 1,
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
    ...overrides,
  };
}

function options(
  sessions: readonly SessionSnapshot[],
  result: NavigationResult = {
    status: 'dispatched',
    target: 'session',
    application: 'codex-desktop',
  },
): SessionOpenerOptions & {
  navigate: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
} {
  const navigate = vi.fn(() => Promise.resolve(result));
  const acknowledge = vi.fn(() => Promise.resolve(true));
  return {
    navigator: { navigate },
    getState: () => ({ sessions, reducedMotion: false }),
    acknowledge,
    navigate,
  };
}

describe('island session opener', () => {
  it('opens a Codex Desktop thread by its native id', async () => {
    const opener = options([session()]);
    await expect(openIslandSession({ sessionId: `codex:${CODEX_ID}` }, opener)).resolves.toEqual({
      handled: true,
    });
    expect(opener.navigate).toHaveBeenCalledWith({
      kind: 'codex-thread',
      nativeSessionId: CODEX_ID,
    });
    expect(opener.acknowledge).not.toHaveBeenCalled();
  });

  it('activates Claude Desktop for its threads', async () => {
    const opener = options([session({ id: 'claude:abc', provider: 'claude' })], {
      status: 'dispatched',
      target: 'application',
      application: 'claude-desktop',
    });
    await openIslandSession({ sessionId: 'claude:abc' }, opener);
    expect(opener.navigate).toHaveBeenCalledWith({
      kind: 'application',
      application: 'claude-desktop',
    });
  });

  it('opens the Desktop app for CLI threads instead of their terminal', async () => {
    for (const [cli, application] of [
      [session({ id: 'claude:cli-1', provider: 'claude', surface: 'cli' }), 'claude-desktop'],
      [session({ id: `codex:${CODEX_ID}`, surface: 'cli' }), 'codex-desktop'],
    ] as const) {
      const opener = options([cli], { status: 'dispatched', target: 'application', application });
      await expect(openIslandSession({ sessionId: cli.id }, opener)).resolves.toEqual({
        handled: true,
      });
      expect(opener.navigate).toHaveBeenCalledWith({ kind: 'application', application });
    }
  });

  it('acknowledges the completion the click saw only after dispatch', async () => {
    const done = session({ status: 'unread', completionId: 'c1' });
    const opener = options([done]);
    await openIslandSession({ sessionId: done.id, completionId: 'c1' }, opener);
    expect(opener.acknowledge).toHaveBeenCalledWith(done.id, 'c1');

    const failing = options([done], {
      status: 'failed',
      target: 'session',
      application: 'codex-desktop',
      reason: 'missing-application',
      stage: 'activation',
    });
    await expect(
      openIslandSession({ sessionId: done.id, completionId: 'c1' }, failing),
    ).resolves.toEqual({ handled: false, reason: 'failed' });
    expect(failing.acknowledge).not.toHaveBeenCalled();
  });

  it('refuses threads it was not shown and threads that cannot open', async () => {
    const opener = options([session({ canOpen: false })]);
    await expect(openIslandSession({ sessionId: 'codex:other' }, opener)).resolves.toEqual({
      handled: false,
      reason: 'unavailable',
    });
    await expect(openIslandSession({ sessionId: `codex:${CODEX_ID}` }, opener)).resolves.toEqual({
      handled: false,
      reason: 'unavailable',
    });
    expect(opener.navigate).not.toHaveBeenCalled();
  });

  it('reports a thrown navigation as failed', async () => {
    const opener = options([session()]);
    opener.navigate.mockRejectedValueOnce(new Error('boom'));
    await expect(openIslandSession({ sessionId: `codex:${CODEX_ID}` }, opener)).resolves.toEqual({
      handled: false,
      reason: 'failed',
    });
  });

  it('maps busy and missing apps to failed and invalid targets to unavailable', async () => {
    for (const [reason, expected] of [
      ['busy', 'failed'],
      ['missing-application', 'failed'],
      ['invalid-target', 'unavailable'],
      ['unsupported-platform', 'unavailable'],
    ] as const) {
      const opener = options([session()], { status: 'failed', target: 'session', reason });
      await expect(openIslandSession({ sessionId: `codex:${CODEX_ID}` }, opener)).resolves.toEqual({
        handled: false,
        reason: expected,
      });
    }
  });

  it('never opens archived or child threads', async () => {
    for (const hidden of [session({ isArchived: true }), session({ isTopLevel: false })]) {
      const opener = options([hidden]);
      await expect(openIslandSession({ sessionId: hidden.id }, opener)).resolves.toEqual({
        handled: false,
        reason: 'unavailable',
      });
      expect(opener.navigate).not.toHaveBeenCalled();
    }
  });

  it('opens a Codex thread exactly only from Desktop with a task id', () => {
    expect(navigationTarget(session())).toEqual({
      kind: 'codex-thread',
      nativeSessionId: CODEX_ID,
    });
    for (const other of [session({ id: 'codex:not-a-task-id' }), session({ surface: 'cli' })]) {
      expect(navigationTarget(other)).toEqual({
        kind: 'application',
        application: 'codex-desktop',
      });
    }
    for (const surface of ['desktop', 'cli'] as const) {
      expect(navigationTarget(session({ id: 'claude:x', provider: 'claude', surface }))).toEqual({
        kind: 'application',
        application: 'claude-desktop',
      });
    }
  });
});

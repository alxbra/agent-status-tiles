import { describe, expect, it, vi } from 'vitest';

import {
  canNavigateTo,
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
  cliOwner: ReturnType<typeof vi.fn>;
} {
  const navigate = vi.fn(() => Promise.resolve(result));
  const acknowledge = vi.fn(() => Promise.resolve(true));
  const cliOwner = vi.fn(() => Promise.resolve('ghostty' as const));
  return {
    navigator: { navigate },
    getState: () => ({ sessions, reducedMotion: false }),
    cliOwner,
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
      provider: 'codex',
      surface: 'desktop',
      nativeSessionId: CODEX_ID,
      owner: 'codex-desktop',
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
      provider: 'claude',
      surface: 'desktop',
      nativeSessionId: 'abc',
      owner: 'claude-desktop',
    });
  });

  it('asks for the terminal that launched a CLI thread', async () => {
    const cli = session({ id: 'claude:cli-1', provider: 'claude', surface: 'cli' });
    const opener = options([cli], {
      status: 'dispatched',
      target: 'application',
      application: 'ghostty',
    });
    await openIslandSession({ sessionId: 'claude:cli-1' }, opener);
    expect(opener.cliOwner).toHaveBeenCalledWith(cli);
    expect(opener.navigate).toHaveBeenCalledWith({
      provider: 'claude',
      surface: 'cli',
      nativeSessionId: 'cli-1',
      owner: 'ghostty',
    });
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

  it('refuses threads it was not shown, threads that cannot open, and unknown terminals', async () => {
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

    const unknown = options([session({ id: 'codex:cli', surface: 'cli' })], {
      status: 'selection-required',
      target: 'application',
      reason: 'unknown-owner',
      options: ['terminal', 'ghostty', 'warp', 'iterm2'],
    });
    await expect(openIslandSession({ sessionId: 'codex:cli' }, unknown)).resolves.toEqual({
      handled: false,
      reason: 'unavailable',
    });
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

  it('reports a failed terminal lookup as failed', async () => {
    const opener = options([session({ id: 'claude:cli-1', provider: 'claude', surface: 'cli' })]);
    opener.cliOwner.mockRejectedValueOnce(new Error('listing failed'));
    await expect(openIslandSession({ sessionId: 'claude:cli-1' }, opener)).resolves.toEqual({
      handled: false,
      reason: 'failed',
    });
    expect(opener.navigate).not.toHaveBeenCalled();
  });

  it('never opens archived, child, or non-navigable threads', async () => {
    for (const hidden of [
      session({ isArchived: true }),
      session({ isTopLevel: false }),
      session({ id: 'codex:not-a-task-id' }),
    ]) {
      const opener = options([hidden]);
      await expect(openIslandSession({ sessionId: hidden.id }, opener)).resolves.toEqual({
        handled: false,
        reason: 'unavailable',
      });
      expect(opener.navigate).not.toHaveBeenCalled();
    }
  });

  it('knows which threads the navigator can bring forward', () => {
    expect(canNavigateTo(session())).toBe(true);
    expect(canNavigateTo(session({ id: 'codex:not-a-task-id' }))).toBe(false);
    expect(canNavigateTo(session({ surface: 'cli' }))).toBe(false);
    expect(canNavigateTo(session({ id: 'claude:x', provider: 'claude' }))).toBe(true);
    expect(canNavigateTo(session({ id: 'claude:x', provider: 'claude', surface: 'cli' }))).toBe(
      true,
    );
  });
});

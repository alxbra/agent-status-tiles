import { describe, expect, it } from 'vitest';

import type { SessionSnapshot } from '../../src/shared/session';
import { summarizeIsland } from '../../src/renderer/island/summary';

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'codex:one',
    provider: 'codex',
    surface: 'desktop',
    title: 'One',
    status: 'idle',
    updatedAt: 1,
    lastTurnStartedAt: 1,
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
    ...overrides,
  };
}

function claude(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return session({ id: 'claude:one', provider: 'claude', surface: 'cli', ...overrides });
}

describe('compact island summary', () => {
  it('shows one white dot and no label while every thread is idle', () => {
    expect(summarizeIsland([session(), claude()])).toEqual({
      dots: [{ tone: 'idle' }],
      label: null,
      target: null,
    });
  });

  it('treats errors and unavailable threads as idle in compact mode', () => {
    expect(
      summarizeIsland([session({ status: 'error' }), claude({ status: 'unavailable' })]),
    ).toEqual({ dots: [{ tone: 'idle' }], label: null, target: null });
  });

  it('shows one dot for a single active harness and hides the idle one', () => {
    const summary = summarizeIsland([session({ status: 'working' }), claude()]);
    expect(summary.dots).toEqual([{ provider: 'codex', tone: 'working' }]);
    expect(summary.label).toBe('Codex is working');
  });

  it('lets a running thread outrank a done thread within one harness', () => {
    const summary = summarizeIsland([
      session({ id: 'codex:done', status: 'unread', completionId: 'c1', updatedAt: 9 }),
      session({ id: 'codex:running', status: 'working', updatedAt: 2 }),
    ]);
    expect(summary.dots).toEqual([{ provider: 'codex', tone: 'working' }]);
    expect(summary.label).toBe('Codex is working');
    expect(summary.target?.id).toBe('codex:running');
  });

  it('lets needs input outrank a running thread within one harness', () => {
    const summary = summarizeIsland([
      claude({ id: 'claude:running', status: 'working', updatedAt: 9 }),
      claude({ id: 'claude:asking', status: 'needs-input', updatedAt: 1 }),
    ]);
    expect(summary.dots).toEqual([{ provider: 'claude', tone: 'needs-input' }]);
    expect(summary.label).toBe('Claude needs input');
  });

  it('names the most recent thread when one harness has several in its top state', () => {
    const summary = summarizeIsland([
      session({ id: 'codex:older', status: 'working', updatedAt: 3 }),
      session({ id: 'codex:newer', status: 'working', updatedAt: 7 }),
    ]);
    expect(summary.target?.id).toBe('codex:newer');
  });

  it('labels a done harness over a working one and keeps both dots', () => {
    const summary = summarizeIsland([
      session({ status: 'unread', completionId: 'c1', updatedAt: 1 }),
      claude({ status: 'working', updatedAt: 9 }),
    ]);
    expect(summary.dots).toEqual([
      { provider: 'claude', tone: 'working' },
      { provider: 'codex', tone: 'unread' },
    ]);
    expect(summary.label).toBe('Codex is done');
    expect(summary.target?.completionId).toBe('c1');
  });

  it('keeps a running thread visible beside another harness that is done', () => {
    // Reported case: Codex finished while Claude still runs one thread and
    // finished another; Claude's dot shows the running thread.
    const summary = summarizeIsland([
      session({ id: 'codex:done', status: 'unread', completionId: 'c1', updatedAt: 5 }),
      claude({ id: 'claude:running', status: 'working', updatedAt: 6 }),
      claude({ id: 'claude:done', status: 'unread', completionId: 'c2', updatedAt: 8 }),
    ]);
    expect(summary.dots).toEqual([
      { provider: 'claude', tone: 'working' },
      { provider: 'codex', tone: 'unread' },
    ]);
    expect(summary.label).toBe('Codex is done');
  });

  it('labels needs input over done across harnesses', () => {
    const summary = summarizeIsland([
      session({ status: 'unread', completionId: 'c1', updatedAt: 9 }),
      claude({ status: 'needs-input', updatedAt: 1 }),
    ]);
    expect(summary.dots).toEqual([
      { provider: 'codex', tone: 'unread' },
      { provider: 'claude', tone: 'needs-input' },
    ]);
    expect(summary.label).toBe('Claude needs input');
  });

  it('says agents are working when every active harness works', () => {
    const summary = summarizeIsland([
      session({ status: 'working', updatedAt: 4 }),
      claude({ status: 'working', updatedAt: 2 }),
    ]);
    const steady = {
      dots: [
        { provider: 'codex', tone: 'working' },
        { provider: 'claude', tone: 'working' },
      ],
      label: 'Agents are working',
    };
    expect(summary).toMatchObject(steady);
    // Neither the label nor the dot order flips when the other harness updates.
    expect(
      summarizeIsland([
        session({ status: 'working', updatedAt: 4 }),
        claude({ status: 'working', updatedAt: 9 }),
      ]),
    ).toMatchObject(steady);
  });

  it('breaks a cross-harness tie by the most recent update', () => {
    const summary = summarizeIsland([
      session({ status: 'unread', completionId: 'c1', updatedAt: 4 }),
      claude({ status: 'unread', completionId: 'c2', updatedAt: 2 }),
    ]);
    expect(summary.label).toBe('Codex is done');
  });

  it('ignores archived threads and spawned child threads', () => {
    const summary = summarizeIsland([
      session({ status: 'needs-input', isArchived: true }),
      session({ id: 'codex:child', status: 'working', isTopLevel: false }),
    ]);
    expect(summary).toEqual({ dots: [{ tone: 'idle' }], label: null, target: null });
  });
});

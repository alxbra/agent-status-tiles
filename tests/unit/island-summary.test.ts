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

describe('compact island summary', () => {
  it('shows one white dot and no label while every thread is idle', () => {
    expect(summarizeIsland([session(), session({ id: 'claude:two', provider: 'claude' })])).toEqual(
      { dots: ['idle'], label: null, target: null },
    );
  });

  it('treats errors and unavailable threads as idle in compact mode', () => {
    const summary = summarizeIsland([
      session({ status: 'error' }),
      session({ id: 'claude:two', provider: 'claude', status: 'unavailable' }),
    ]);
    expect(summary.dots).toEqual(['idle']);
    expect(summary.label).toBeNull();
  });

  it('names the most recently updated working thread', () => {
    const summary = summarizeIsland([
      session({ status: 'working', updatedAt: 5 }),
      session({ id: 'claude:two', provider: 'claude', status: 'working', updatedAt: 9 }),
    ]);
    expect(summary.dots).toEqual(['working']);
    expect(summary.label).toBe('Claude is working');
    expect(summary.target?.id).toBe('claude:two');
  });

  it('shows a lone green dot for a done thread with nothing working', () => {
    const summary = summarizeIsland([
      session({ status: 'unread', completionId: 'c1' }),
      session({ id: 'claude:two', provider: 'claude' }),
    ]);
    expect(summary.dots).toEqual(['unread']);
    expect(summary.label).toBe('Codex is done');
    expect(summary.target?.completionId).toBe('c1');
  });

  it('pairs blue on the left with green on the right and keeps the done label', () => {
    const summary = summarizeIsland([
      session({ status: 'working', updatedAt: 20 }),
      session({
        id: 'claude:two',
        provider: 'claude',
        status: 'unread',
        completionId: 'c2',
        updatedAt: 3,
      }),
    ]);
    expect(summary.dots).toEqual(['working', 'unread']);
    expect(summary.label).toBe('Claude is done');
    expect(summary.target?.id).toBe('claude:two');
  });

  it('lets needs input win over done and working threads', () => {
    const summary = summarizeIsland([
      session({ status: 'working', updatedAt: 30 }),
      session({ id: 'codex:two', status: 'unread', completionId: 'c2', updatedAt: 40 }),
      session({ id: 'claude:three', provider: 'claude', status: 'needs-input', updatedAt: 1 }),
    ]);
    expect(summary.dots).toEqual(['needs-input']);
    expect(summary.label).toBe('Claude needs input');
    expect(summary.target?.id).toBe('claude:three');
  });

  it('ignores archived and child threads like the tab dock did', () => {
    const summary = summarizeIsland([
      session({ status: 'needs-input', isArchived: true }),
      session({ id: 'codex:child', status: 'working', isTopLevel: false }),
    ]);
    expect(summary).toEqual({ dots: ['idle'], label: null, target: null });
  });
});

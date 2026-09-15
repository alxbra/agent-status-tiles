import { describe, expect, it } from 'vitest';

import type { SessionSnapshot } from '../../src/shared/session';
import {
  canAcknowledgeTarget,
  captureOpenTarget,
  isSameSessionOrder,
  updateFrozenSessionStatuses,
  visibleTileSessions,
} from '../../src/renderer/tiles';

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'codex:one',
    provider: 'codex',
    surface: 'desktop',
    title: 'One',
    status: 'unread',
    updatedAt: 1,
    lastTurnStartedAt: 1,
    completionId: 'completion-1',
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
    ...overrides,
  };
}

describe('status tile interaction invariants', () => {
  it('captures the completion visible at pointer-down and rejects a newer completion', () => {
    const captured = captureOpenTarget(session());

    expect(captured).toEqual({ sessionId: 'codex:one', completionId: 'completion-1' });
    expect(canAcknowledgeTarget(captured, session())).toBe(true);
    expect(
      canAcknowledgeTarget(captured, session({ completionId: 'completion-2', updatedAt: 2 })),
    ).toBe(false);
  });

  it('freezes membership/order but forwards status and completion changes', () => {
    const frozen = [
      session(),
      session({ id: 'claude:two', title: 'Two', completionId: undefined }),
    ];
    const incoming = [
      session({ status: 'working', completionId: undefined, updatedAt: 3 }),
      session({ id: 'codex:three', title: 'Three', status: 'error' }),
    ];

    const updated = updateFrozenSessionStatuses(frozen, incoming);

    expect(updated.map(({ id }) => id)).toEqual(['codex:one', 'claude:two']);
    expect(updated[0]).toMatchObject({ status: 'working', completionId: undefined, updatedAt: 3 });
    expect(updated[1]).toMatchObject({ status: 'unread', title: 'Two' });
  });

  it('keeps only qualifying top-level sessions in the initial list', () => {
    const visible = visibleTileSessions([
      session(),
      session({ id: 'codex:idle', status: 'idle' }),
      session({ id: 'codex:archived', isArchived: true }),
      session({ id: 'codex:child', isTopLevel: false }),
    ]);

    expect(visible.map(({ id }) => id)).toEqual(['codex:one']);
  });

  it('compares order by identity so pending additions/removals can apply on exit', () => {
    const first = [session(), session({ id: 'codex:two' })];
    const same = [session(), session({ id: 'codex:two', title: 'Renamed' })];
    const changed = [session({ id: 'codex:two' }), session()];

    expect(isSameSessionOrder(first, same)).toBe(true);
    expect(isSameSessionOrder(first, changed)).toBe(false);
  });
});

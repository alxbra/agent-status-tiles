import { describe, expect, it } from 'vitest';

import type { SessionSnapshot } from '../../src/shared/session';
import {
  completionSnapshot,
  finishedHarnesses,
  islandTarget,
  summarizeHarnesses,
} from '../../src/renderer/island/summary';

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

function tones(sessions: readonly SessionSnapshot[]): readonly string[] {
  return summarizeHarnesses(sessions).map((column) => `${column.provider}:${column.tone}`);
}

describe('harness columns', () => {
  it('always shows Codex then Claude, idle when nothing runs', () => {
    expect(tones([])).toEqual(['codex:idle', 'claude:idle']);
    expect(tones([session(), claude()])).toEqual(['codex:idle', 'claude:idle']);
  });

  it('treats done, failed, and unavailable threads as idle', () => {
    expect(
      tones([
        session({ status: 'unread', completionId: 'c1' }),
        claude({ status: 'error' }),
        claude({ id: 'claude:two', status: 'unavailable' }),
      ]),
    ).toEqual(['codex:idle', 'claude:idle']);
  });

  it('shows a harness as working while any of its threads runs, even beside a done one', () => {
    expect(
      tones([
        session({ id: 'codex:done', status: 'unread', completionId: 'c1', updatedAt: 9 }),
        session({ id: 'codex:running', status: 'working', updatedAt: 2 }),
      ]),
    ).toEqual(['codex:working', 'claude:idle']);
  });

  it('lets needs input outrank working within a harness', () => {
    const columns = summarizeHarnesses([
      claude({ id: 'claude:running', status: 'working', updatedAt: 9 }),
      claude({ id: 'claude:asking', status: 'needs-input', updatedAt: 1 }),
    ]);
    expect(columns[1]).toMatchObject({ tone: 'needs-input', target: { id: 'claude:asking' } });
  });

  it('keeps the harnesses independent', () => {
    expect(tones([session({ status: 'working' }), claude({ status: 'needs-input' })])).toEqual([
      'codex:working',
      'claude:needs-input',
    ]);
  });

  it('ignores archived threads and spawned child threads', () => {
    expect(
      tones([
        session({ status: 'needs-input', isArchived: true }),
        session({ id: 'codex:child', status: 'working', isTopLevel: false }),
      ]),
    ).toEqual(['codex:idle', 'claude:idle']);
  });

  it('opens a thread waiting for input first, then the newest working one', () => {
    expect(
      islandTarget(
        summarizeHarnesses([
          session({ status: 'working', updatedAt: 9 }),
          claude({ status: 'needs-input', updatedAt: 1 }),
        ]),
      )?.id,
    ).toBe('claude:one');
    expect(
      islandTarget(
        summarizeHarnesses([
          session({ status: 'working', updatedAt: 2 }),
          claude({ status: 'working', updatedAt: 7 }),
        ]),
      )?.id,
    ).toBe('claude:one');
    expect(islandTarget(summarizeHarnesses([session()]))).toBeNull();
  });
});

describe('finished turns', () => {
  it('seeds silently on the first snapshot', () => {
    expect(finishedHarnesses(null, [session({ status: 'unread', completionId: 'c1' })])).toEqual(
      new Set(),
    );
  });

  it('reports a harness whose thread gained a new completion', () => {
    const before = completionSnapshot([
      session({ status: 'working' }),
      claude({ status: 'working' }),
    ]);
    const finished = finishedHarnesses(before, [
      session({ status: 'unread', completionId: 'c1' }),
      claude({ status: 'working' }),
    ]);
    expect(finished).toEqual(new Set(['codex']));
  });

  it('ignores unchanged completions and threads it has not seen before', () => {
    const before = completionSnapshot([session({ status: 'unread', completionId: 'c1' })]);
    expect(
      finishedHarnesses(before, [
        session({ status: 'unread', completionId: 'c1' }),
        claude({ status: 'unread', completionId: 'c9' }),
      ]),
    ).toEqual(new Set());
  });

  it('counts a second turn finishing on the same thread', () => {
    const before = completionSnapshot([session({ status: 'working', completionId: 'c1' })]);
    expect(finishedHarnesses(before, [session({ status: 'unread', completionId: 'c2' })])).toEqual(
      new Set(['codex']),
    );
  });
});

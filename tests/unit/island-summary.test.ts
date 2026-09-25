import { describe, expect, it } from 'vitest';

import type { SessionSnapshot } from '../../src/shared/session';
import {
  completionSnapshot,
  finishedHarnesses,
  MAX_REMEMBERED_COMPLETIONS,
  columnTarget,
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

  it('opens a question first, then a just-finished thread, then work', () => {
    const asking = session({ id: 'codex:asking', status: 'needs-input', updatedAt: 1 });
    const running = session({ id: 'codex:running', status: 'working', updatedAt: 2 });
    const done = session({ id: 'codex:done', status: 'unread', completionId: 'c1', updatedAt: 9 });
    const [withQuestion] = summarizeHarnesses([asking, running, done]);
    expect(columnTarget(withQuestion!, done)?.id).toBe('codex:asking');
    const [working] = summarizeHarnesses([running, done]);
    expect(columnTarget(working!, done)?.id).toBe('codex:done');
    expect(columnTarget(working!, undefined)?.id).toBe('codex:running');
    const [idle] = summarizeHarnesses([done, session({ id: 'codex:old', updatedAt: 3 })]);
    expect(idle).toMatchObject({ tone: 'idle', latest: { id: 'codex:done' } });
    // An idle harness's column is hidden, so it has nothing to open.
    expect(columnTarget(idle!, undefined)).toBeNull();
  });
});

describe('finished turns', () => {
  it('seeds silently on the first snapshot', () => {
    expect(finishedHarnesses(null, [session({ status: 'unread', completionId: 'c1' })])).toEqual(
      new Map(),
    );
  });

  it('reports a harness whose thread gained a new completion', () => {
    const before = completionSnapshot(null, [
      session({ status: 'working' }),
      claude({ status: 'working' }),
    ]);
    const finished = finishedHarnesses(before, [
      session({ status: 'unread', completionId: 'c1' }),
      claude({ status: 'working' }),
    ]);
    expect([...finished.keys()]).toEqual(['codex']);
    expect(finished.get('codex')?.completionId).toBe('c1');
  });

  it('ignores unchanged completions and threads it has not seen before', () => {
    const before = completionSnapshot(null, [session({ status: 'unread', completionId: 'c1' })]);
    expect(
      finishedHarnesses(before, [
        session({ status: 'unread', completionId: 'c1' }),
        claude({ status: 'unread', completionId: 'c9' }),
      ]),
    ).toEqual(new Map());
  });

  it('ignores a completion that arrives already acknowledged, as replayed history does', () => {
    const before = completionSnapshot(null, [session()]);
    expect(finishedHarnesses(before, [session({ status: 'idle', completionId: 'old' })])).toEqual(
      new Map(),
    );
  });

  it('counts each turn on the same thread, since a new turn clears the completion', () => {
    let snapshot = completionSnapshot(null, [session({ status: 'unread', completionId: 'c1' })]);
    const working = [session({ status: 'working' })];
    expect(finishedHarnesses(snapshot, working)).toEqual(new Map());
    snapshot = completionSnapshot(snapshot, working);
    expect(
      finishedHarnesses(snapshot, [session({ status: 'unread', completionId: 'c2' })]),
    ).toEqual(new Map([['codex', expect.objectContaining({ id: 'codex:one' })]]));
  });

  it('remembers a thread that left the recent list and finishes when it returns', () => {
    let snapshot = completionSnapshot(null, [session({ status: 'working' })]);
    // The thread drops out of a one-item recent list while it keeps working.
    snapshot = completionSnapshot(snapshot, [claude({ status: 'working' })]);
    expect(
      finishedHarnesses(snapshot, [
        session({ status: 'unread', completionId: 'c1', updatedAt: 9 }),
      ]),
    ).toEqual(new Map([['codex', expect.objectContaining({ id: 'codex:one' })]]));
  });

  it('bounds how many threads it remembers', () => {
    let snapshot = completionSnapshot(null, []);
    for (let index = 0; index < MAX_REMEMBERED_COMPLETIONS + 10; index += 1) {
      snapshot = completionSnapshot(snapshot, [session({ id: `codex:${String(index)}` })]);
    }
    expect(snapshot.size).toBe(MAX_REMEMBERED_COMPLETIONS);
    expect(snapshot.has(`codex:${String(MAX_REMEMBERED_COMPLETIONS + 9)}`)).toBe(true);
    expect(snapshot.has('codex:0')).toBe(false);
  });
});

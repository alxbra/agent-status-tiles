import { describe, expect, it } from 'vitest';

import {
  createTestSessionSnapshots,
  parseTestSessionCount,
  TEST_SESSION_COUNT_FLAG,
} from '../../src/main/test-session-source';

describe('test-only overlay session source', () => {
  it('accepts only bounded integer counts in test mode', () => {
    expect(parseTestSessionCount([`${TEST_SESSION_COUNT_FLAG}0`], 'test', false)).toBe(0);
    expect(parseTestSessionCount([`${TEST_SESSION_COUNT_FLAG}30`], 'test', false)).toBe(30);
    expect(parseTestSessionCount([`${TEST_SESSION_COUNT_FLAG}31`], 'test', false)).toBe(0);
    expect(parseTestSessionCount([`${TEST_SESSION_COUNT_FLAG}-1`], 'test', false)).toBe(0);
    expect(parseTestSessionCount([`${TEST_SESSION_COUNT_FLAG}1.5`], 'test', false)).toBe(0);
  });

  it('is disabled outside test mode and generates only sanitized snapshots', () => {
    expect(parseTestSessionCount([`${TEST_SESSION_COUNT_FLAG}12`], 'production', false)).toBe(0);
    expect(parseTestSessionCount([`${TEST_SESSION_COUNT_FLAG}12`], 'test', true)).toBe(0);
    expect(parseTestSessionCount([`${TEST_SESSION_COUNT_FLAG}12`], 'test')).toBe(0);
    const snapshots = createTestSessionSnapshots(30);
    expect(snapshots).toHaveLength(30);
    expect(snapshots[0]).toMatchObject({
      id: 'codex:test-session-1',
      provider: 'codex',
      surface: 'desktop',
      title: 'Test session 1',
      status: 'working',
      isTopLevel: true,
      isArchived: false,
      canOpen: true,
    });
    expect(Object.keys(snapshots[0]!)).toEqual([
      'id',
      'provider',
      'surface',
      'title',
      'status',
      'updatedAt',
      'lastTurnStartedAt',
      'isTopLevel',
      'isArchived',
      'canOpen',
    ]);
    expect(JSON.stringify(snapshots)).not.toMatch(/prompt|transcript|path|credential/u);
    expect(createTestSessionSnapshots(-1)).toEqual([]);
    expect(createTestSessionSnapshots(31)).toEqual([]);
  });
});

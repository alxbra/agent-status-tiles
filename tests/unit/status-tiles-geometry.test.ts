import { describe, expect, it } from 'vitest';

import type { SessionSnapshot } from '../../src/shared/session';
import {
  DEFAULT_STRIP_WIDTH,
  DOCK_PADDING,
  layoutTabs,
  MAX_VISIBLE_TABS,
  minimumHeightForSlots,
  normalizeStripWidth,
  revealedTabWidth,
  TAB_GAP,
  TAB_HEIGHT,
  TAB_HIT_MIN_WIDTH,
  TAB_ICON_GAP,
  TAB_ICON_SIZE,
  TAB_PADDING_START,
  TAB_PEEK_DOCK,
  TAB_PEEK_IDLE,
  tabHitRegion,
  visibleSlotCount,
} from '../../src/renderer/tiles';

function session(id: string): SessionSnapshot {
  return {
    id,
    provider: 'codex',
    surface: 'desktop',
    title: id,
    status: 'working',
    updatedAt: 1,
    lastTurnStartedAt: 1,
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
  };
}

function sessions(count: number): readonly SessionSnapshot[] {
  return Array.from({ length: count }, (_, index) => session(`codex:session-${index}`));
}

function expectRegionsInside(layout: ReturnType<typeof layoutTabs>, height: number): void {
  for (const region of layout.hitRegions) {
    expect(region.x).toBeGreaterThanOrEqual(0);
    expect(region.y).toBeGreaterThanOrEqual(0);
    expect(region.x + region.width).toBeLessThanOrEqual(DEFAULT_STRIP_WIDTH);
    expect(region.y + region.height).toBeLessThanOrEqual(height);
  }
}

function expectHitRegionsDoNotOverlap(layout: ReturnType<typeof layoutTabs>): void {
  const regions = [...layout.hitRegions].sort((left, right) => left.y - right.y);
  for (let index = 1; index < regions.length; index += 1) {
    expect(regions[index]!.y).toBeGreaterThanOrEqual(
      regions[index - 1]!.y + regions[index - 1]!.height,
    );
  }
}

describe('tab dock geometry', () => {
  it('normalizes non-finite and too-narrow strip widths', () => {
    expect(normalizeStripWidth(Number.NaN)).toBe(DEFAULT_STRIP_WIDTH);
    expect(normalizeStripWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_STRIP_WIDTH);
    expect(normalizeStripWidth(10)).toBe(TAB_HIT_MIN_WIDTH);
    expect(normalizeStripWidth(500)).toBe(500);
  });

  it('reveals a colored sliver, then the lab icon, then the whole tab', () => {
    expect(TAB_PEEK_IDLE).toBe(12);
    expect(TAB_PEEK_DOCK).toBe(TAB_PADDING_START + TAB_ICON_SIZE + TAB_ICON_GAP);
    expect(revealedTabWidth('folded', 290)).toBe(TAB_PEEK_IDLE);
    expect(revealedTabWidth('dock', 290)).toBe(TAB_PEEK_DOCK);
    expect(revealedTabWidth('extended', 290)).toBe(290);
    expect(revealedTabWidth('dock', 20)).toBe(20);
  });

  it('anchors a folded tab to the right edge with a wider native hit target', () => {
    const layout = layoutTabs(sessions(1), { width: DEFAULT_STRIP_WIDTH, height: 480 });
    const slot = layout.slots[0]!;

    expect(slot.y).toBe(226);
    expect(slot.hitRegion).toEqual({
      x: DEFAULT_STRIP_WIDTH - TAB_HIT_MIN_WIDTH,
      y: 226,
      width: TAB_HIT_MIN_WIDTH,
      height: TAB_HEIGHT,
      sessionId: 'codex:session-0',
    });
    expect(layout.top).toBe(226);
    expect(layout.bottom).toBe(226 + TAB_HEIGHT);
    expectRegionsInside(layout, 480);
  });

  it('centers the stack and keeps a fixed gap between tabs', () => {
    const layout = layoutTabs(sessions(5), { height: 480 });
    const top = Math.round((480 - (5 * TAB_HEIGHT + 4 * TAB_GAP)) / 2);

    expect(layout.slots.map((slot) => slot.y)).toEqual(
      Array.from({ length: 5 }, (_, index) => top + index * (TAB_HEIGHT + TAB_GAP)),
    );
    expect(layout.top).toBe(top);
    expect(layout.bottom).toBe(top + 5 * TAB_HEIGHT + 4 * TAB_GAP);
    expectRegionsInside(layout, 480);
    expectHitRegionsDoNotOverlap(layout);
  });

  it('fits slots to the available height with room for overflow cues', () => {
    expect(visibleSlotCount(480)).toBe(MAX_VISIBLE_TABS);
    expect(minimumHeightForSlots(3)).toBe(3 * TAB_HEIGHT + 2 * TAB_GAP + DOCK_PADDING * 2);
    expect(visibleSlotCount(minimumHeightForSlots(3))).toBe(3);
    expect(visibleSlotCount(minimumHeightForSlots(3) - 0.1)).toBe(2);
    expect(visibleSlotCount(minimumHeightForSlots(1) - 0.1, 1)).toBe(0);
    expect(layoutTabs(sessions(1), { height: minimumHeightForSlots(1) - 0.1 }).slots).toHaveLength(
      0,
    );
    expect(minimumHeightForSlots(0)).toBe(0);
  });

  it('limits visible slots to twelve and exposes directional overflow state', () => {
    const layout = layoutTabs(sessions(30), { height: 480, scrollOffset: 7 });

    expect(layout.slots).toHaveLength(12);
    expect(layout.visibleStart).toBe(7);
    expect(layout.hasPrevious).toBe(true);
    expect(layout.hasNext).toBe(true);
    expect(layout.slots[0]?.index).toBe(7);
    expect(layout.slots.at(-1)?.index).toBe(18);
    expectRegionsInside(layout, 480);
  });

  it('turns rendered tab rectangles into bounded native hit targets', () => {
    const width = DEFAULT_STRIP_WIDTH;
    const folded = tabHitRegion(
      { left: width - TAB_PEEK_IDLE, top: 226, width: 290, height: TAB_HEIGHT },
      width,
      'codex:a',
    );
    expect(folded).toEqual({
      x: width - TAB_HIT_MIN_WIDTH,
      y: 226,
      width: TAB_HIT_MIN_WIDTH,
      height: TAB_HEIGHT,
      sessionId: 'codex:a',
    });

    const dock = tabHitRegion(
      { left: width - TAB_PEEK_DOCK, top: 226, width: 290, height: TAB_HEIGHT },
      width,
      'codex:a',
    );
    expect(dock).toMatchObject({ x: width - TAB_PEEK_DOCK, width: TAB_PEEK_DOCK });

    const extended = tabHitRegion(
      { left: width - 290, top: 226, width: 290, height: TAB_HEIGHT },
      width,
      'codex:a',
    );
    expect(extended).toMatchObject({ x: width - 290, width: 290 });

    expect(
      tabHitRegion({ left: width + 1, top: 0, width: 290, height: TAB_HEIGHT }, width, 'codex:a'),
    ).toMatchObject({ x: width - TAB_HIT_MIN_WIDTH, width: TAB_HIT_MIN_WIDTH });
    expect(
      tabHitRegion({ left: Number.NaN, top: 0, width: 290, height: TAB_HEIGHT }, width, 'codex:a'),
    ).toBeNull();
    expect(tabHitRegion({ left: 0, top: 0, width: 290, height: 0 }, width, 'codex:a')).toBeNull();
  });
});

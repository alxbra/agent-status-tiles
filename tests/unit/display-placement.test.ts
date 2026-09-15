import { describe, expect, it, vi } from 'vitest';

const screenMock = vi.hoisted(() => ({
  getAllDisplays: vi.fn(),
  getPrimaryDisplay: vi.fn(),
}));

vi.mock('electron', () => ({ screen: screenMock }));

import {
  connectedDisplays,
  displayOptionsWithPreference,
  selectPreferredDisplay,
} from '../../src/main/display';
import type { Display } from 'electron';

type TestDisplay = {
  id: number;
  internal: boolean;
  label: string;
  workArea: { x: number; y: number; width: number; height: number };
};

function display(id: number, workArea: TestDisplay['workArea'], label = ''): Display {
  return { id, internal: id === 1, label, workArea } as unknown as Display;
}

describe('display placement', () => {
  it('selects a connected preference, falls back to primary, and restores on reconnect', () => {
    const primary = display(1, { x: 0, y: 24, width: 1440, height: 876 });
    const external = display(42, { x: -1200, y: -200, width: 1200, height: 900 });
    expect(selectPreferredDisplay('42', [primary, external], primary)).toBe(external);
    expect(selectPreferredDisplay('99', [primary], primary)).toBe(primary);
    expect(selectPreferredDisplay('42', [primary], primary)).toBe(primary);
    expect(selectPreferredDisplay('42', [primary, external], primary)).toBe(external);
  });

  it('keeps the chosen display work area, including negative coordinates, intact', () => {
    const primary = display(1, { x: 0, y: 0, width: 800, height: 600 });
    const external = display(42, { x: -1200, y: -200, width: 1200, height: 900 });
    expect(selectPreferredDisplay('42', [primary, external], primary).workArea).toEqual(
      external.workArea,
    );

    screenMock.getAllDisplays.mockReturnValue([primary, external]);
    expect(connectedDisplays()).toEqual([primary, external]);
    expect(displayOptionsWithPreference([primary, external], '99')).toEqual([
      { id: 'primary', label: 'Primary' },
      { id: '1', label: 'Built-in Display' },
      { id: '42', label: 'Display 2' },
      { id: '99', label: 'Unavailable' },
    ]);
    // The disconnected preference is retained as the selected item, not silently reset.
    expect(displayOptionsWithPreference([primary], '42').at(-1)).toEqual({
      id: '42',
      label: 'Unavailable',
    });
  });

  it('bounds projected display options while retaining a disconnected preference', () => {
    const manyDisplays = Array.from({ length: 40 }, (_, index) =>
      display(index + 1, { x: index * 800, y: 0, width: 800, height: 600 }),
    );
    const options = displayOptionsWithPreference(manyDisplays, '999');

    expect(options).toHaveLength(32);
    expect(options[0]).toEqual({ id: 'primary', label: 'Primary' });
    expect(options.at(-1)).toEqual({ id: '999', label: 'Unavailable' });
  });

  it('replaces a display label that exceeds the shared UTF-8 byte bound', () => {
    const oversizedLabel = '🖥️'.repeat(96);
    const external = display(42, { x: 800, y: 0, width: 800, height: 600 }, oversizedLabel);

    expect(displayOptionsWithPreference([external], '42')).toEqual([
      { id: 'primary', label: 'Primary' },
      { id: '42', label: 'Display 1' },
    ]);
  });
});

import { screen, type Display } from 'electron';

import {
  isSerializedDisplayId,
  MAX_DISPLAY_LABEL_BYTES,
  MAX_SETTINGS_DISPLAYS,
  PRIMARY_DISPLAY_ID,
  type SettingsDisplayOption,
} from '../shared/settings';

export function serializeDisplayId(display: Pick<Display, 'id'>): string {
  return String(display.id);
}

/** Use the selected connected display, or primary when the preference is unavailable. */
export function selectPreferredDisplay(
  preferredDisplayId: string,
  displays: readonly Display[],
  primaryDisplay: Display,
): Display {
  if (preferredDisplayId !== PRIMARY_DISPLAY_ID) {
    const selected = displays.find((display) => serializeDisplayId(display) === preferredDisplayId);
    if (selected !== undefined) return selected;
  }
  return primaryDisplay;
}

export function connectedDisplays(): readonly Display[] {
  return typeof screen.getAllDisplays === 'function'
    ? screen.getAllDisplays()
    : [screen.getPrimaryDisplay()];
}

function conciseDisplayLabel(display: Display, index: number): string {
  const label = typeof display.label === 'string' ? display.label.trim() : '';
  if (
    label.length > 0 &&
    new TextEncoder().encode(label).byteLength <= MAX_DISPLAY_LABEL_BYTES &&
    !/\p{Cc}/u.test(label)
  ) {
    return label;
  }
  return display.internal ? 'Built-in Display' : `Display ${String(index + 1)}`;
}

/** Build the settings Select options from the displays currently connected to the system. */
export function displayOptions(displays: readonly Display[]): readonly SettingsDisplayOption[] {
  const options: SettingsDisplayOption[] = [{ id: PRIMARY_DISPLAY_ID, label: 'Primary' }];
  const seen = new Set(options.map((option) => option.id));
  displays.forEach((display, index) => {
    if (options.length >= MAX_SETTINGS_DISPLAYS) return;
    const id = serializeDisplayId(display);
    if (!isSerializedDisplayId(id) || seen.has(id)) return;
    seen.add(id);
    options.push({ id, label: conciseDisplayLabel(display, index) });
  });
  return options;
}

/** Keep a disconnected preference visible as the selected Select item, without altering it. */
export function displayOptionsWithPreference(
  displays: readonly Display[],
  preferredDisplayId: string,
): readonly SettingsDisplayOption[] {
  const options = [...displayOptions(displays)];
  if (
    preferredDisplayId !== PRIMARY_DISPLAY_ID &&
    !options.some((option) => option.id === preferredDisplayId)
  ) {
    if (options.length >= MAX_SETTINGS_DISPLAYS) options.pop();
    options.push({ id: preferredDisplayId, label: 'Unavailable' });
  }
  return options;
}

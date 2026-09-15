import { describe, expect, it } from 'vitest';

import { SettingsLoadSequence } from '../../src/renderer/settings-load-sequence';

describe('Settings initial load sequence', () => {
  it('rejects a late initial success or failure after a valid publication', () => {
    const sequence = new SettingsLoadSequence();
    expect(sequence.shouldAcceptInitialResult()).toBe(true);

    sequence.markPublicationReceived();

    expect(sequence.shouldAcceptInitialResult()).toBe(false);
  });
});

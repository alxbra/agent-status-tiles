import { describe, expect, it, vi } from 'vitest';

import { retryOverlayHandshake } from '../../src/renderer/overlay-readiness';

describe('overlay renderer readiness retries', () => {
  it('retries a rejected operation within the configured bound', async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('not registered'))
      .mockRejectedValueOnce(new Error('not registered'))
      .mockResolvedValue(undefined);
    const wait = vi.fn(async () => undefined);

    await expect(retryOverlayHandshake(operation, [0, 10, 20], wait)).resolves.toBe(true);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
  });

  it('stops after the configured attempts remain unavailable', async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('unavailable'));

    await expect(retryOverlayHandshake(operation, [0, 0, 0], async () => undefined)).resolves.toBe(
      false,
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

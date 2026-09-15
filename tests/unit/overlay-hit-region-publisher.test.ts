import { describe, expect, it, vi } from 'vitest';

import { createOverlayHitRegionPublisher } from '../../src/renderer/overlay-hit-region-publisher';
import type { OverlayHitRegion } from '../../src/shared/overlay-ipc';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const tileRegion = [{ x: 300, y: 100, width: 24, height: 24 }] as const;
const portalRegion = [
  ...tileRegion,
  { x: 120, y: 100, width: 160, height: 30 },
] as const satisfies readonly OverlayHitRegion[];

describe('overlay hit-region publisher', () => {
  it('restores current geometry after a stale pending publication succeeds', async () => {
    const publications = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    const publish = vi.fn(() => publications[publish.mock.calls.length - 1]!.promise);
    const publisher = createOverlayHitRegionPublisher(publish);

    publisher.update(tileRegion);
    publications[0]!.resolve(true);
    await publications[0]!.promise;
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

    publisher.update(portalRegion);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    publisher.update(tileRegion);
    expect(publish).toHaveBeenCalledTimes(2);
    publications[1]!.resolve(true);
    await publications[1]!.promise;
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(3));
    expect(publish).toHaveBeenLastCalledWith(tileRegion);
    publications[2]!.resolve(true);
  });

  it('allows an identical geometry to retry after rejection', async () => {
    const first = deferred<boolean>();
    const publish = vi.fn(() => first.promise);
    const publisher = createOverlayHitRegionPublisher(publish);

    publisher.update(tileRegion);
    first.reject(new Error('window changed'));
    await first.promise.catch(() => undefined);
    publish.mockResolvedValue(true);
    await vi.waitFor(() => {
      publisher.update(tileRegion);
      expect(publish).toHaveBeenCalledTimes(2);
    });
  });

  it('restores desired geometry after a newer publication is rejected', async () => {
    const publications = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    const publish = vi.fn(() => publications[publish.mock.calls.length - 1]!.promise);
    const publisher = createOverlayHitRegionPublisher(publish);

    publisher.update(tileRegion);
    publications[0]!.resolve(true);
    await publications[0]!.promise;
    publisher.update(portalRegion);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    publisher.update(tileRegion);

    publications[1]!.resolve(false);
    await publications[1]!.promise;
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(3));
    expect(publish).toHaveBeenLastCalledWith(tileRegion);
    publications[2]!.resolve(true);
  });
});

import type { OverlayHitRegion } from '../shared/overlay-ipc';

export interface OverlayHitRegionPublisher {
  update(regions: readonly OverlayHitRegion[]): void;
  stop(): void;
}

/** Serializes region updates and republishes the latest geometry after stale work settles. */
export function createOverlayHitRegionPublisher(
  publish: (regions: readonly OverlayHitRegion[]) => Promise<boolean>,
): OverlayHitRegionPublisher {
  let acceptedKey = '';
  let desired: { key: string; regions: readonly OverlayHitRegion[] } | null = null;
  let inFlight = false;
  let isStopped = false;

  const flush = (): void => {
    if (isStopped || inFlight || desired === null || desired.key === acceptedKey) return;
    const publication = desired;
    inFlight = true;
    void publish(publication.regions)
      .then((accepted) => {
        // A rejected update means the main process cleared its native region
        // set, so no previously accepted renderer key remains authoritative.
        acceptedKey = accepted ? publication.key : '';
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (
          !isStopped &&
          desired !== null &&
          desired.key !== publication.key &&
          desired.key !== acceptedKey
        ) {
          flush();
        }
      });
  };

  return {
    update: (regions) => {
      desired = { key: JSON.stringify(regions), regions };
      flush();
    },
    stop: () => {
      isStopped = true;
      desired = null;
    },
  };
}

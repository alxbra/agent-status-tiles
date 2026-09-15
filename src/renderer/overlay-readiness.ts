export const OVERLAY_HANDSHAKE_RETRY_DELAYS_MS = [0, 50, 150] as const;

export async function retryOverlayHandshake(
  operation: () => Promise<unknown>,
  delays: readonly number[] = OVERLAY_HANDSHAKE_RETRY_DELAYS_MS,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<boolean> {
  for (const delay of delays) {
    if (delay > 0) await wait(delay);
    try {
      await operation();
      return true;
    } catch {
      // Keep the window hidden while the bounded handshake retry continues.
    }
  }
  return false;
}

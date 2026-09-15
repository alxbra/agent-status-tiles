import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppLifecycleController } from '../../src/main/app-lifecycle';

describe('app lifecycle coordination', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovers the overlay for every activation and opens Settings for user activation', () => {
    const recoverOverlay = vi.fn();
    const openSettings = vi.fn();
    const lifecycle = createAppLifecycleController({ recoverOverlay, openSettings });

    lifecycle.handleActivate();

    expect(recoverOverlay).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();
    lifecycle.destroy();
  });

  it('suppresses all activations caused by returning focus to the previous application', () => {
    vi.useFakeTimers();
    const recoverOverlay = vi.fn();
    const openSettings = vi.fn();
    const lifecycle = createAppLifecycleController({
      recoverOverlay,
      openSettings,
      suppressionDurationMs: 50,
    });

    lifecycle.expectOverlayRestoreActivation();
    lifecycle.handleActivate();
    lifecycle.handleActivate();

    expect(recoverOverlay).toHaveBeenCalledTimes(2);
    expect(openSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    lifecycle.handleActivate();
    expect(recoverOverlay).toHaveBeenCalledTimes(3);
    expect(openSettings).toHaveBeenCalledOnce();
    lifecycle.destroy();
  });

  it('makes shutdown and post-destroy callbacks inert', () => {
    const recoverOverlay = vi.fn();
    const openSettings = vi.fn();
    const lifecycle = createAppLifecycleController({ recoverOverlay, openSettings });

    lifecycle.expectOverlayRestoreActivation();
    lifecycle.destroy();
    lifecycle.destroy();
    lifecycle.handleActivate();
    lifecycle.expectOverlayRestoreActivation();

    expect(recoverOverlay).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });
});

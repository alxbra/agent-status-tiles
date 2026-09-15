import { describe, expect, it, vi } from 'vitest';

import { createAppLifecycleController } from '../../src/main/app-lifecycle';

describe('app lifecycle coordination', () => {
  it('recovers the overlay for every activation and opens Settings for user activation', () => {
    const recoverOverlay = vi.fn();
    const openSettings = vi.fn();
    const lifecycle = createAppLifecycleController({ recoverOverlay, openSettings });

    lifecycle.handleActivate();

    expect(recoverOverlay).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();
    lifecycle.destroy();
  });

  it('makes shutdown and post-destroy callbacks inert', () => {
    const recoverOverlay = vi.fn();
    const openSettings = vi.fn();
    const lifecycle = createAppLifecycleController({ recoverOverlay, openSettings });

    lifecycle.destroy();
    lifecycle.destroy();
    lifecycle.handleActivate();
    expect(recoverOverlay).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });
});

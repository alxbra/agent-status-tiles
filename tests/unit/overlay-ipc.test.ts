import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
  };
});

vi.mock('electron', () => electronMocks);

import {
  isOverlayDismissErrorRequest,
  isOverlayHitRegions,
  isOverlayOpenSessionRequest,
  isOverlayState,
  OVERLAY_ACTION_UNAVAILABLE,
  OVERLAY_IPC_CHANNELS,
  type OverlayState,
} from '../../src/shared/overlay-ipc';

function session(index = 1): OverlayState['sessions'][number] {
  return {
    id: `codex:test-session-${String(index)}`,
    provider: 'codex',
    surface: 'desktop',
    title: `Test session ${String(index)}`,
    status: 'working',
    updatedAt: index,
    lastTurnStartedAt: index,
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
  };
}

function state(): OverlayState {
  return { sessions: [session()], reducedMotion: false };
}

function overlayWindow(): {
  isDestroyed: ReturnType<typeof vi.fn>;
  webContents: { mainFrame: object; send: ReturnType<typeof vi.fn> };
} {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { mainFrame: {}, send: vi.fn() },
  };
}

describe('overlay IPC contract validators', () => {
  it('allows only the projected session metadata and bounded state size', () => {
    expect(isOverlayState(state())).toBe(true);
    expect(isOverlayState({ ...state(), path: '/private/project' })).toBe(false);
    expect(
      isOverlayState({
        ...state(),
        sessions: Array.from({ length: 257 }, (_, index) => session(index + 1)),
      }),
    ).toBe(false);
    expect(
      isOverlayState({
        ...state(),
        sessions: [{ ...session(), updatedAt: Number.POSITIVE_INFINITY }],
      }),
    ).toBe(false);
  });

  it('bounds geometry and accepts only exact command payload keys', () => {
    expect(isOverlayHitRegions([])).toBe(true);
    expect(isOverlayHitRegions([{ x: 0, y: 0, width: 24, height: 24 }])).toBe(true);
    expect(isOverlayHitRegions([{ x: 0, y: 0, width: Number.NaN, height: 24 }])).toBe(false);
    expect(isOverlayHitRegions([{ x: 0, y: 0, width: 24, height: 24, sessionId: 'secret' }])).toBe(
      false,
    );
    expect(
      isOverlayHitRegions(Array.from({ length: 13 }, () => ({ x: 0, y: 0, width: 1, height: 1 }))),
    ).toBe(false);
    expect(isOverlayOpenSessionRequest({ sessionId: 'codex:one' })).toBe(true);
    expect(isOverlayOpenSessionRequest({ sessionId: 'codex:one', completionId: undefined })).toBe(
      false,
    );
    expect(isOverlayOpenSessionRequest({ sessionId: 'codex:one', path: '/private' })).toBe(false);
    expect(isOverlayDismissErrorRequest({ sessionId: 'codex:one' })).toBe(true);
    expect(isOverlayDismissErrorRequest({ sessionId: '' })).toBe(false);
  });
});

describe('overlay IPC handlers', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    electronMocks.ipcMain.handle.mockClear();
    electronMocks.ipcMain.removeHandler.mockClear();
  });

  it('rejects impostor and child-frame senders on every invoke', async () => {
    const { registerOverlayIpcHandlers } = await import('../../src/main/overlay-ipc');
    const window = overlayWindow();
    const mainFrame = window.webContents.mainFrame;
    const options = {
      getWindow: () => window as never,
      getState: state,
      setHitRegions: vi.fn(() => true),
    };
    const cleanup = registerOverlayIpcHandlers(options);
    const impostor = { sender: {}, senderFrame: mainFrame };
    const childFrame = { sender: window.webContents, senderFrame: {}, payload: undefined };

    for (const channel of [
      OVERLAY_IPC_CHANNELS.getState,
      OVERLAY_IPC_CHANNELS.publishHitRegions,
      OVERLAY_IPC_CHANNELS.openSession,
      OVERLAY_IPC_CHANNELS.dismissError,
    ]) {
      const handler = electronMocks.handlers.get(channel)!;
      await expect(Promise.resolve().then(() => handler(impostor, childFrame))).rejects.toThrow(
        'Overlay IPC sender is not recognized',
      );
      await expect(
        Promise.resolve().then(() =>
          handler({ sender: window.webContents, senderFrame: {} }, childFrame),
        ),
      ).rejects.toThrow('Overlay IPC sender is not recognized');
    }
    cleanup();
  });

  it('returns explicit unavailable results without opening or dismissing', async () => {
    const { registerOverlayIpcHandlers } = await import('../../src/main/overlay-ipc');
    const window = overlayWindow();
    const frame = window.webContents.mainFrame;
    registerOverlayIpcHandlers({
      getWindow: () => window as never,
      getState: state,
      setHitRegions: vi.fn(() => true),
    });
    const event = { sender: window.webContents, senderFrame: frame };

    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(OVERLAY_IPC_CHANNELS.openSession)!(event, {
          sessionId: 'codex:one',
        }),
      ),
    ).resolves.toEqual(OVERLAY_ACTION_UNAVAILABLE);
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(OVERLAY_IPC_CHANNELS.dismissError)!(event, {
          sessionId: 'codex:one',
        }),
      ),
    ).resolves.toEqual(OVERLAY_ACTION_UNAVAILABLE);

    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(OVERLAY_IPC_CHANNELS.openSession)!(event, {
          sessionId: 'codex:one',
          path: '/private',
        }),
      ),
    ).rejects.toThrow('Overlay open-session request is invalid');
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(OVERLAY_IPC_CHANNELS.dismissError)!(event, {
          sessionId: '',
        }),
      ),
    ).rejects.toThrow('Overlay dismiss-error request is invalid');
  });

  it('validates hit regions and publishes only a valid state projection', async () => {
    const { publishOverlayState, registerOverlayIpcHandlers } =
      await import('../../src/main/overlay-ipc');
    const window = overlayWindow();
    const setHitRegions = vi.fn(() => true);
    registerOverlayIpcHandlers({
      getWindow: () => window as never,
      getState: state,
      setHitRegions,
    });
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(OVERLAY_IPC_CHANNELS.getState)!(event, {}),
      ),
    ).rejects.toThrow('Overlay state request does not accept a payload');
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(OVERLAY_IPC_CHANNELS.publishHitRegions)!(event, [
          { x: 1, y: 2, width: 24, height: 24 },
        ]),
      ),
    ).resolves.toBe(true);
    expect(setHitRegions).toHaveBeenCalledWith([{ x: 1, y: 2, width: 24, height: 24 }]);
    await expect(
      Promise.resolve().then(() =>
        electronMocks.handlers.get(OVERLAY_IPC_CHANNELS.publishHitRegions)!(event, [
          { x: 1, y: 2, width: Number.NaN, height: 24 },
        ]),
      ),
    ).rejects.toThrow('Overlay hit regions are invalid');

    expect(publishOverlayState(window as never, state())).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith(
      OVERLAY_IPC_CHANNELS.stateChanged,
      state(),
    );
    expect(publishOverlayState(window as never, { ...state(), unexpected: true } as never)).toBe(
      false,
    );
  });

  it('removes exactly the invoke handlers it registered', async () => {
    const { registerOverlayIpcHandlers } = await import('../../src/main/overlay-ipc');
    const window = overlayWindow();
    const cleanup = registerOverlayIpcHandlers({
      getWindow: () => window as never,
      getState: state,
      setHitRegions: vi.fn(() => true),
    });
    cleanup();
    cleanup();
    expect(electronMocks.ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      OVERLAY_IPC_CHANNELS.getState,
      OVERLAY_IPC_CHANNELS.publishHitRegions,
      OVERLAY_IPC_CHANNELS.openSession,
      OVERLAY_IPC_CHANNELS.dismissError,
    ]);
  });
});

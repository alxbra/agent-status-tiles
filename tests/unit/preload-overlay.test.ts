import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    listeners,
    contextBridge: {
      exposeInMainWorld: vi.fn(),
    },
    ipcRenderer: {
      invoke: vi.fn(() => Promise.resolve(undefined)),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      }),
      removeListener: vi.fn((channel: string) => listeners.delete(channel)),
    },
  };
});

vi.mock('electron', () => electronMocks);

import { OVERLAY_IPC_CHANNELS } from '../../src/shared/overlay-ipc';

describe('overlay preload keyboard bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMocks.listeners.clear();
    electronMocks.contextBridge.exposeInMainWorld.mockReset();
    electronMocks.ipcRenderer.invoke.mockReset();
    electronMocks.ipcRenderer.invoke.mockResolvedValue(undefined);
    electronMocks.ipcRenderer.on.mockClear();
    electronMocks.ipcRenderer.removeListener.mockClear();
  });

  it('invokes keyboard exit without a payload and validates the no-payload result', async () => {
    await import('../../src/preload/overlay');
    const api = electronMocks.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      requestKeyboardExit: (...args: unknown[]) => Promise<void>;
    };

    await expect(api.requestKeyboardExit()).resolves.toBeUndefined();
    expect(electronMocks.ipcRenderer.invoke).toHaveBeenCalledWith(
      OVERLAY_IPC_CHANNELS.keyboardExit,
    );

    electronMocks.ipcRenderer.invoke.mockResolvedValue({ unexpected: true } as never);
    await expect(api.requestKeyboardExit()).rejects.toThrow(
      'Overlay keyboard-exit result is invalid',
    );
  });

  it('opens a session through IPC and accepts only a known action result', async () => {
    await import('../../src/preload/overlay');
    const api = electronMocks.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      openSession: (request: unknown) => Promise<unknown>;
    };

    electronMocks.ipcRenderer.invoke.mockResolvedValue({ handled: true } as never);
    await expect(api.openSession({ sessionId: 'codex:one', completionId: 'c1' })).resolves.toEqual({
      handled: true,
    });
    expect(electronMocks.ipcRenderer.invoke).toHaveBeenCalledWith(
      OVERLAY_IPC_CHANNELS.openSession,
      { sessionId: 'codex:one', completionId: 'c1' },
    );
    electronMocks.ipcRenderer.invoke.mockResolvedValue({
      handled: false,
      reason: 'failed',
    } as never);
    await expect(api.openSession({ sessionId: 'codex:one' })).resolves.toEqual({
      handled: false,
      reason: 'failed',
    });
    electronMocks.ipcRenderer.invoke.mockResolvedValue({ handled: true, extra: 1 } as never);
    await expect(api.openSession({ sessionId: 'codex:one' })).rejects.toThrow(
      'Overlay action result is invalid',
    );
    // A malformed request never reaches main.
    electronMocks.ipcRenderer.invoke.mockClear();
    await expect(api.openSession({ sessionId: '' })).resolves.toEqual({
      handled: false,
      reason: 'unavailable',
    });
    expect(electronMocks.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('announces renderer readiness without a payload and validates the result', async () => {
    await import('../../src/preload/overlay');
    const api = electronMocks.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      rendererReady: () => Promise<void>;
    };

    await expect(api.rendererReady()).resolves.toBeUndefined();
    expect(electronMocks.ipcRenderer.invoke).toHaveBeenCalledWith(
      OVERLAY_IPC_CHANNELS.rendererReady,
    );

    electronMocks.ipcRenderer.invoke.mockResolvedValue({ unexpected: true } as never);
    await expect(api.rendererReady()).rejects.toThrow('Overlay renderer-ready result is invalid');
  });

  it('filters payload-bearing entry events and cleans up the subscription', async () => {
    await import('../../src/preload/overlay');
    const api = electronMocks.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      subscribeKeyboardEntry: (listener: () => void) => () => void;
    };
    const listener = vi.fn();
    const cleanup = api.subscribeKeyboardEntry(listener);
    const entryListener = electronMocks.listeners.get(OVERLAY_IPC_CHANNELS.keyboardEntry);
    if (entryListener === undefined) throw new Error('Keyboard-entry listener was not registered');

    entryListener({});
    entryListener({}, { unexpected: true });
    expect(listener).toHaveBeenCalledOnce();
    cleanup();
    cleanup();
    expect(electronMocks.ipcRenderer.removeListener).toHaveBeenCalledWith(
      OVERLAY_IPC_CHANNELS.keyboardEntry,
      entryListener,
    );
  });
});

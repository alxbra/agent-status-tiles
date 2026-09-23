import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  LSAPPINFO_ARGUMENTS,
  LSAPPINFO_PATH,
  MAX_NOTIFICATION_LINE_LENGTH,
  parseBecameFrontmost,
  startFrontAppMonitor,
  type FrontAppProcess,
} from '../../src/main/navigation/front-app-monitor';
import { completionsSeenOnActivation } from '../../src/main/runtime/front-app-acknowledgement';
import type { SessionSnapshot } from '../../src/shared/session';

const BECAME_FRONTMOST =
  'Notification: kLSNotifyBecameFrontmost time=+0.108736s  dataRef={ "ApplicationType"="Foreground", ' +
  '"CFBundleIdentifier"="com.openai.codex", "LSASN"=ASN:0x0-0x45045:, "LSFrontApplicationSeed"=2321 } ' +
  'affectedASN="Codex" ASN:0x0-0x45045:  context=0 sessionID=186af notificationID=0x769b0023a0';

class FakeProcess extends EventEmitter implements FrontAppProcess {
  readonly stdout = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe('front app monitor', () => {
  it('reads only becameFrontmost notifications with a plain bundle identifier', () => {
    expect(parseBecameFrontmost(BECAME_FRONTMOST)).toBe('com.openai.codex');
    expect(
      parseBecameFrontmost(
        BECAME_FRONTMOST.replace('kLSNotifyBecameFrontmost', 'kLSNotifyLostFrontmost'),
      ),
    ).toBeUndefined();
    expect(
      parseBecameFrontmost(BECAME_FRONTMOST.replace('com.openai.codex', 'com.openai codex')),
    ).toBeUndefined();
    expect(parseBecameFrontmost(`  ${BECAME_FRONTMOST}`)).toBeUndefined();
  });

  it('reports activations split across chunks and skips overlong lines', () => {
    const child = new FakeProcess();
    const seen: string[] = [];
    const monitor = startFrontAppMonitor((bundleId) => seen.push(bundleId), {
      spawnProcess: () => child,
    });
    child.stdout.write(BECAME_FRONTMOST.slice(0, 40));
    child.stdout.write(`${BECAME_FRONTMOST.slice(40)}\n`);
    child.stdout.write(`${'x'.repeat(MAX_NOTIFICATION_LINE_LENGTH + 1)}\n`);
    child.stdout.write(
      `${BECAME_FRONTMOST.replace('com.openai.codex', 'com.anthropic.claudefordesktop')}\n`,
    );
    expect(seen).toEqual(['com.openai.codex', 'com.anthropic.claudefordesktop']);
    monitor.stop();
    expect(child.killed).toBe(true);
  });

  it('restarts with backoff after lsappinfo exits and stops for good', () => {
    const children: FakeProcess[] = [];
    const timers: { callback: () => void; delayMs: number }[] = [];
    const clearTimer = vi.fn();
    const monitor = startFrontAppMonitor(() => undefined, {
      spawnProcess: () => {
        const child = new FakeProcess();
        children.push(child);
        return child;
      },
      setTimer: (callback, delayMs) => {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimer,
    });

    children[0]!.emit('exit');
    expect(timers.map((timer) => timer.delayMs)).toEqual([1_000]);
    timers[0]!.callback();
    children[1]!.emit('error');
    expect(timers.map((timer) => timer.delayMs)).toEqual([1_000, 5_000]);

    monitor.stop();
    expect(clearTimer).toHaveBeenCalledWith(timers[1]);
    timers[1]!.callback();
    expect(children).toHaveLength(2);
  });

  it.runIf(process.platform === 'darwin')(
    'uses an lsappinfo notification code macOS accepts',
    () => {
      // An unknown code makes lsappinfo print "Unrecognized command" and
      // exit; a valid listener keeps running until the timeout stops it.
      const result = spawnSync(LSAPPINFO_PATH, [...LSAPPINFO_ARGUMENTS], {
        encoding: 'utf8',
        timeout: 1_000,
      });
      expect(result.signal).toBe('SIGTERM');
      expect(`${result.stdout}${result.stderr}`).not.toContain('Unrecognized');
    },
  );
});

function snapshot(overrides: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    id: 'codex:one',
    provider: 'codex',
    surface: 'desktop',
    title: 'One',
    status: 'unread',
    completionId: 'c1',
    updatedAt: 1,
    lastTurnStartedAt: 1,
    isTopLevel: true,
    isArchived: false,
    canOpen: true,
    ...overrides,
  };
}

describe('completions seen on activation', () => {
  const sessions = [
    snapshot({ id: 'codex:desktop-done' }),
    snapshot({ id: 'codex:desktop-working', status: 'working', completionId: undefined }),
    snapshot({ id: 'codex:cli-done', surface: 'cli', completionId: 'c2' }),
    snapshot({ id: 'claude:desktop-done', provider: 'claude', completionId: 'c3' }),
    snapshot({ id: 'claude:cli-done', provider: 'claude', surface: 'cli', completionId: 'c4' }),
  ];

  it("acknowledges only the activated desktop app's own done threads", () => {
    expect(completionsSeenOnActivation('com.openai.codex', sessions)).toEqual([
      { sessionId: 'codex:desktop-done', completionId: 'c1' },
    ]);
    expect(completionsSeenOnActivation('com.anthropic.claudefordesktop', sessions)).toEqual([
      { sessionId: 'claude:desktop-done', completionId: 'c3' },
    ]);
  });

  it("acknowledges both providers' CLI threads when a qualified terminal activates", () => {
    for (const bundleId of [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'com.mitchellh.ghostty',
      'dev.warp.Warp-Stable',
    ]) {
      expect(completionsSeenOnActivation(bundleId, sessions)).toEqual([
        { sessionId: 'codex:cli-done', completionId: 'c2' },
        { sessionId: 'claude:cli-done', completionId: 'c4' },
      ]);
    }
  });

  it('ignores other apps', () => {
    expect(completionsSeenOnActivation('com.apple.finder', sessions)).toEqual([]);
  });
});

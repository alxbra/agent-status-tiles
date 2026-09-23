import { spawn } from 'node:child_process';

/**
 * macOS's LaunchServices client. `listen +becameFrontmost` reports each app
 * activation with its bundle identifier and needs no Accessibility, Automation,
 * or Screen Recording permission.
 */
export const LSAPPINFO_PATH = '/usr/bin/lsappinfo';
export const LSAPPINFO_ARGUMENTS = Object.freeze(['listen', '+becameFrontmost', 'forever']);

/** Longest notification line kept, in characters; longer lines are dropped unparsed. */
export const MAX_NOTIFICATION_LINE_LENGTH = 16 * 1024;
const RESTART_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000, 60_000]);
const NOTIFICATION_PATTERN =
  /^Notification: kLSNotifyBecameFrontmost\b.*?"CFBundleIdentifier"="([A-Za-z0-9.-]{1,255})"/u;

/** The bundle identifier of an app that just became frontmost, if the line reports one. */
export function parseBecameFrontmost(line: string): string | undefined {
  return NOTIFICATION_PATTERN.exec(line)?.[1];
}

export interface FrontAppProcess {
  stdout: NodeJS.ReadableStream | null;
  once(event: 'exit' | 'error', listener: () => void): unknown;
  kill(): boolean;
}

export interface FrontAppMonitorOptions {
  spawnProcess?: () => FrontAppProcess;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface FrontAppMonitor {
  stop(): void;
}

function spawnLsappinfo(): FrontAppProcess {
  return spawn(LSAPPINFO_PATH, [...LSAPPINFO_ARGUMENTS], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Report every app that becomes frontmost. The listener restarts with backoff
 * if lsappinfo exits, and `stop` ends it for good.
 */
export function startFrontAppMonitor(
  onFrontmost: (bundleId: string) => void,
  options: FrontAppMonitorOptions = {},
): FrontAppMonitor {
  const spawnProcess = options.spawnProcess ?? spawnLsappinfo;
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let child: FrontAppProcess | null = null;
  let restartTimer: unknown = null;
  let failures = 0;
  let stopped = false;

  const scheduleRestart = (): void => {
    if (stopped || restartTimer !== null) return;
    const delay = RESTART_DELAYS_MS[Math.min(failures, RESTART_DELAYS_MS.length - 1)]!;
    failures += 1;
    restartTimer = setTimer(() => {
      restartTimer = null;
      start();
    }, delay);
  };

  const start = (): void => {
    if (stopped) return;
    let current: FrontAppProcess;
    try {
      current = spawnProcess();
    } catch {
      scheduleRestart();
      return;
    }
    child = current;
    let pending = '';
    current.stdout?.setEncoding('utf8');
    current.stdout?.on('data', (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length <= MAX_NOTIFICATION_LINE_LENGTH) {
          const bundleId = parseBecameFrontmost(line);
          if (bundleId !== undefined) {
            // A delivered notification proves the listener works again.
            failures = 0;
            onFrontmost(bundleId);
          }
        }
        newline = pending.indexOf('\n');
      }
      if (pending.length > MAX_NOTIFICATION_LINE_LENGTH) pending = '';
    });
    const onEnd = (): void => {
      if (child !== current) return;
      child = null;
      scheduleRestart();
    };
    current.once('exit', onEnd);
    current.once('error', onEnd);
  };

  start();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (restartTimer !== null) clearTimer(restartTimer);
      restartTimer = null;
      const current = child;
      child = null;
      current?.kill();
    },
  };
}

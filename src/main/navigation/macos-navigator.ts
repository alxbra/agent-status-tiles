import { spawn, type ChildProcess } from 'node:child_process';

const OPEN_EXECUTABLE = '/usr/bin/open';
const ACTIVATION_WAIT_MS = 175;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_192;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;

const CODEX_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MACOS_APPLICATIONS = Object.freeze({
  codexDesktop: Object.freeze({
    application: 'codex-desktop',
    bundleId: 'com.openai.codex',
  }),
  claudeDesktop: Object.freeze({
    application: 'claude-desktop',
    bundleId: 'com.anthropic.claudefordesktop',
  }),
} as const);

export type NavigationApplication =
  (typeof MACOS_APPLICATIONS)[keyof typeof MACOS_APPLICATIONS]['application'];

/**
 * A Codex Desktop thread opens exactly; anything else only brings its
 * harness's Desktop app forward.
 */
export type QualifiedNavigationTarget =
  | { kind: 'codex-thread'; nativeSessionId: string }
  | { kind: 'application'; application: NavigationApplication };

export interface ProcessOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  hasTimedOut: boolean;
  isCleanupConfirmed: boolean;
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

export type NavigationFailureReason =
  | 'invalid-target'
  | 'unsupported-platform'
  | 'missing-application'
  | 'timeout'
  | 'command-failed'
  | 'cleanup-unconfirmed'
  | 'busy';

export type NavigationResult =
  | {
      status: 'dispatched';
      target: 'session';
      application: 'codex-desktop';
    }
  | {
      status: 'dispatched';
      target: 'application';
      application: NavigationApplication;
    }
  | {
      status: 'failed';
      target: 'session' | 'application';
      application?: NavigationApplication;
      reason: NavigationFailureReason;
      stage?: 'activation' | 'session-link';
    };

export function isCodexTaskId(value: unknown): value is string {
  return typeof value === 'string' && CODEX_UUID_PATTERN.test(value);
}

export function createCodexTaskLink(nativeSessionId: string): string {
  if (!isCodexTaskId(nativeSessionId)) throw new Error('Invalid Codex task identifier');
  return `codex://threads/${nativeSessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Exactly these own keys, so nothing inherited or extra reaches the navigator. */
function hasOnlyOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isValidTarget(value: unknown): value is QualifiedNavigationTarget {
  if (!isRecord(value)) return false;
  try {
    if (value.kind === 'codex-thread') {
      return (
        hasOnlyOwnKeys(value, ['kind', 'nativeSessionId']) && isCodexTaskId(value.nativeSessionId)
      );
    }
    if (value.kind === 'application') {
      return (
        hasOnlyOwnKeys(value, ['kind', 'application']) &&
        (value.application === 'codex-desktop' || value.application === 'claude-desktop')
      );
    }
    return false;
  } catch {
    return false;
  }
}

function getBoundedOption(value: number, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), maximum);
}

export function normalizeProcessOptions(options: Partial<ProcessOptions> = {}): ProcessOptions {
  return {
    timeoutMs: getBoundedOption(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    maxOutputBytes: getBoundedOption(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
    ),
  };
}

export type ProcessFactory = (executable: string, args: readonly string[]) => ChildProcess;

function appendOutput(
  chunks: Buffer[],
  byteCount: { value: number },
  chunk: Buffer,
  limit: number,
) {
  if (byteCount.value >= limit) return;
  const retained = Buffer.from(chunk.subarray(0, limit - byteCount.value));
  chunks.push(retained);
  byteCount.value += retained.length;
}

/**
 * Runs one owned process with argv, bounded output, and cleanup on timeout.
 * The navigator only uses this for /usr/bin/open; it deliberately does not
 * expose a shell command escape hatch.
 */
function spawnNavigationProcess(executable: string, args: readonly string[]): ChildProcess {
  return spawn(executable, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function createNavigationProcessRunner(
  factory: ProcessFactory = spawnNavigationProcess,
): ProcessRunner {
  const ownedChildren = new Set<ChildProcess>();
  return (executable, args, options) => {
    const { timeoutMs, maxOutputBytes } = normalizeProcessOptions(options);
    if (ownedChildren.size > 0) {
      return Promise.resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        hasTimedOut: false,
        isCleanupConfirmed: false,
      });
    }
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = factory(executable, args);
      } catch {
        resolve({
          exitCode: null,
          stdout: '',
          stderr: '',
          hasTimedOut: false,
          isCleanupConfirmed: true,
        });
        return;
      }
      ownedChildren.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const outputBytes = { value: 0 };
      let hasDeliveredResult = false;
      let hasTerminationStarted = false;
      let hasTerminationTimedOut = false;
      let terminationTimer: NodeJS.Timeout | undefined;
      let hasOwnershipReleased = false;
      const timer = setTimeout(() => {
        terminate(true);
      }, timeoutMs);

      const getCapturedOutput = (): Pick<ProcessResult, 'stdout' | 'stderr'> => ({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });

      const releaseOwnership = (): void => {
        if (hasOwnershipReleased) return;
        hasOwnershipReleased = true;
        clearTimeout(timer);
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        ownedChildren.delete(child);
        child.removeAllListeners();
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const deliver = (result: ProcessResult): void => {
        if (hasDeliveredResult) return;
        hasDeliveredResult = true;
        resolve(result);
      };

      const finish = (result: ProcessResult): void => {
        releaseOwnership();
        deliver(result);
      };

      const terminate = (hasTimedOut: boolean): void => {
        if (hasTerminationStarted || hasDeliveredResult) return;
        hasTerminationStarted = true;
        hasTerminationTimedOut = hasTimedOut;
        try {
          child.kill('SIGKILL');
        } catch {
          // The close/error handlers below still determine the bounded result.
        }
        terminationTimer = setTimeout(() => {
          deliver({
            ...getCapturedOutput(),
            exitCode: null,
            hasTimedOut,
            isCleanupConfirmed: false,
          });
        }, TERMINATION_GRACE_MS);
      };

      child.stdout?.on('data', (chunk: Buffer) =>
        appendOutput(stdout, outputBytes, chunk, maxOutputBytes),
      );
      child.stderr?.on('data', (chunk: Buffer) =>
        appendOutput(stderr, outputBytes, chunk, maxOutputBytes),
      );
      child.stdout?.on('error', () => terminate(false));
      child.stderr?.on('error', () => terminate(false));
      child.on('error', () => terminate(false));
      child.once('close', (exitCode) => {
        const captured = getCapturedOutput();
        finish({
          ...captured,
          exitCode: hasTerminationStarted ? null : exitCode,
          hasTimedOut: hasTerminationTimedOut,
          isCleanupConfirmed: true,
        });
      });
    });
  };
}

const defaultNavigationProcessRunner = createNavigationProcessRunner();

export function runNavigationProcess(
  executable: string,
  args: readonly string[],
  options: Partial<ProcessOptions> = {},
): Promise<ProcessResult> {
  return defaultNavigationProcessRunner(executable, args, normalizeProcessOptions(options));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getFailureReason(result: ProcessResult): NavigationFailureReason {
  if (result.hasTimedOut) return 'timeout';
  if (
    /unable to find|application isn.?t running|does not exist|bundle identifier/i.test(
      result.stderr,
    )
  ) {
    return 'missing-application';
  }
  return 'command-failed';
}

export class MacOsNavigator {
  private isInFlight = false;

  constructor(
    private readonly run: ProcessRunner = runNavigationProcess,
    private readonly pause: (milliseconds: number) => Promise<void> = wait,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async navigate(target: unknown): Promise<NavigationResult> {
    if (!isValidTarget(target)) {
      return { status: 'failed', target: 'application', reason: 'invalid-target' };
    }
    const resultTarget = target.kind === 'codex-thread' ? 'session' : 'application';
    if (this.platform !== 'darwin') {
      return { status: 'failed', target: resultTarget, reason: 'unsupported-platform' };
    }
    if (this.isInFlight) return { status: 'failed', target: resultTarget, reason: 'busy' };

    this.isInFlight = true;
    try {
      if (target.kind === 'codex-thread') return await this.navigateCodex(target.nativeSessionId);
      const application =
        target.application === 'codex-desktop'
          ? MACOS_APPLICATIONS.codexDesktop
          : MACOS_APPLICATIONS.claudeDesktop;
      const activation = await this.activate(application.bundleId);
      if (activation !== undefined) {
        return {
          status: 'failed',
          target: 'application',
          application: application.application,
          ...activation,
        };
      }
      return { status: 'dispatched', target: 'application', application: application.application };
    } finally {
      this.isInFlight = false;
    }
  }

  private async navigateCodex(nativeSessionId: string): Promise<NavigationResult> {
    const activation = await this.activate(MACOS_APPLICATIONS.codexDesktop.bundleId);
    if (activation !== undefined) {
      return {
        status: 'failed',
        target: 'session',
        application: 'codex-desktop',
        stage: 'activation',
        ...activation,
      };
    }
    await this.pause(ACTIVATION_WAIT_MS);
    const linkResult = await this.runCommand([
      '-g',
      '-b',
      MACOS_APPLICATIONS.codexDesktop.bundleId,
      createCodexTaskLink(nativeSessionId),
    ]);
    if (linkResult !== undefined) {
      return {
        status: 'failed',
        target: 'session',
        application: 'codex-desktop',
        stage: 'session-link',
        ...linkResult,
      };
    }
    return { status: 'dispatched', target: 'session', application: 'codex-desktop' };
  }

  private async activate(
    bundleId: string,
  ): Promise<{ reason: NavigationFailureReason } | undefined> {
    return this.runCommand(['-b', bundleId]);
  }

  private async runCommand(
    args: readonly string[],
  ): Promise<{ reason: NavigationFailureReason } | undefined> {
    try {
      const result = await this.run(OPEN_EXECUTABLE, args, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });
      if (!result.isCleanupConfirmed) return { reason: 'cleanup-unconfirmed' };
      if (result.exitCode !== 0 || result.hasTimedOut) return { reason: getFailureReason(result) };
      return undefined;
    } catch (error) {
      if (error instanceof Error && /timed out/i.test(error.message)) {
        return { reason: 'timeout' };
      }
      return { reason: 'command-failed' };
    }
  }
}

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  MACOS_APPLICATIONS,
  MacOsNavigator,
  createNavigationProcessRunner,
  normalizeProcessOptions,
  type ProcessFactory,
  type ProcessResult,
  runNavigationProcess,
} from '../../src/main/navigation/macos-navigator';

const codexId = '019f6b6d-644d-7701-8858-9da6837aaaaa';

function createSuccessfulResult(): ProcessResult {
  return { exitCode: 0, stdout: '', stderr: '', hasTimedOut: false, isCleanupConfirmed: true };
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  killCalls = 0;

  constructor(private readonly killResult: 'false' | 'throw' | 'true') {
    super();
  }

  kill(): boolean {
    this.killCalls += 1;
    if (this.killResult === 'throw') throw new Error('kill failed');
    return this.killResult === 'true';
  }
}

function createFakeFactory(child: FakeChild): ProcessFactory {
  return () => child as unknown as ChildProcess;
}

function createRunner(result: ProcessResult = createSuccessfulResult()) {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const run = vi.fn(async (executable: string, args: readonly string[]) => {
    calls.push({ executable, args: [...args] });
    return result;
  });
  return { calls, run };
}

describe('macOS application navigation', () => {
  it('opens the validated Codex task only after foregrounding Codex', async () => {
    const { calls, run } = createRunner();
    const pause = vi.fn(() => Promise.resolve());
    const navigator = new MacOsNavigator(run, pause, 'darwin');

    await expect(
      navigator.navigate({ kind: 'codex-thread', nativeSessionId: codexId }),
    ).resolves.toEqual({ status: 'dispatched', target: 'session', application: 'codex-desktop' });
    expect(calls).toEqual([
      { executable: '/usr/bin/open', args: ['-b', MACOS_APPLICATIONS.codexDesktop.bundleId] },
      {
        executable: '/usr/bin/open',
        args: ['-g', '-b', MACOS_APPLICATIONS.codexDesktop.bundleId, `codex://threads/${codexId}`],
      },
    ]);
    expect(pause).toHaveBeenCalledWith(175);
  });

  it('rejects hostile or mismatched targets without invoking open', async () => {
    const { calls, run } = createRunner();
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );

    for (const target of [
      { kind: 'codex-thread', nativeSessionId: '../../etc/passwd' },
      { kind: 'codex-thread', nativeSessionId: codexId, application: 'claude-desktop' },
      { kind: 'application', application: 'ghostty' },
      { kind: 'application', application: '__proto__' },
      { kind: 'application', application: 'codex-desktop', nativeSessionId: codexId },
      { kind: 'session', nativeSessionId: codexId },
      Object.create({ kind: 'codex-thread', nativeSessionId: codexId }),
      // An inherited kind with two own fields still fails.
      Object.assign(Object.create({ kind: 'codex-thread' }), {
        nativeSessionId: codexId,
        application: 'codex-desktop',
      }),
      Object.assign(Object.create({ kind: 'application' }), {
        application: 'claude-desktop',
        extra: true,
      }),
      Object.assign(Object.create({ application: 'claude-desktop' }), {
        kind: 'application',
        extra: true,
      }),
      null,
    ]) {
      await expect(navigator.navigate(target)).resolves.toMatchObject({
        status: 'failed',
        reason: 'invalid-target',
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('reports an unsupported platform without attempting activation', async () => {
    const { calls, run } = createRunner();
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'linux',
    );

    await expect(
      navigator.navigate({ kind: 'application', application: 'claude-desktop' }),
    ).resolves.toEqual({ status: 'failed', target: 'application', reason: 'unsupported-platform' });
    expect(calls).toHaveLength(0);
  });

  it('activates Claude without fabricating a session link', async () => {
    const { calls, run } = createRunner();
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );

    await expect(
      navigator.navigate({ kind: 'application', application: 'claude-desktop' }),
    ).resolves.toEqual({
      status: 'dispatched',
      target: 'application',
      application: 'claude-desktop',
    });
    expect(calls).toEqual([
      { executable: '/usr/bin/open', args: ['-b', MACOS_APPLICATIONS.claudeDesktop.bundleId] },
    ]);
  });

  it('activates Codex Desktop for a thread it cannot open exactly', async () => {
    const { calls, run } = createRunner();
    const pause = vi.fn(() => Promise.resolve());
    const navigator = new MacOsNavigator(run, pause, 'darwin');

    await expect(
      navigator.navigate({ kind: 'application', application: 'codex-desktop' }),
    ).resolves.toEqual({
      status: 'dispatched',
      target: 'application',
      application: 'codex-desktop',
    });
    expect(calls).toEqual([
      { executable: '/usr/bin/open', args: ['-b', MACOS_APPLICATIONS.codexDesktop.bundleId] },
    ]);
    expect(pause).not.toHaveBeenCalled();
  });

  it('reports missing apps and timeouts without exposing process output', async () => {
    const missing = createRunner({
      exitCode: 1,
      stdout: 'ignored stdout',
      stderr: 'Unable to find application by bundle identifier',
      hasTimedOut: false,
      isCleanupConfirmed: true,
    });
    const navigator = new MacOsNavigator(
      missing.run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );
    await expect(
      navigator.navigate({ kind: 'application', application: 'claude-desktop' }),
    ).resolves.toEqual({
      status: 'failed',
      target: 'application',
      application: 'claude-desktop',
      reason: 'missing-application',
    });

    const timeout = createRunner({
      exitCode: null,
      stdout: 'secret',
      stderr: 'secret',
      hasTimedOut: true,
      isCleanupConfirmed: true,
    });
    const timedOutNavigator = new MacOsNavigator(
      timeout.run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );
    await expect(
      timedOutNavigator.navigate({ kind: 'codex-thread', nativeSessionId: codexId }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'timeout', stage: 'activation' });
  });

  it('does not fall back to another Codex invocation when the link dispatch fails', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const run = vi.fn(async (executable: string, args: readonly string[]) => {
      calls.push({ executable, args: [...args] });
      return calls.length === 1
        ? createSuccessfulResult()
        : {
            exitCode: 1,
            stdout: '',
            stderr: 'open failed',
            hasTimedOut: false,
            isCleanupConfirmed: true,
          };
    });
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );

    await expect(
      navigator.navigate({ kind: 'codex-thread', nativeSessionId: codexId }),
    ).resolves.toEqual({
      status: 'failed',
      target: 'session',
      application: 'codex-desktop',
      stage: 'session-link',
      reason: 'command-failed',
    });
    expect(calls).toHaveLength(2);
  });

  it('allows one navigation at a time and reports a concurrent request as busy', async () => {
    let release!: () => void;
    const firstProcess = new Promise<ProcessResult>((resolve) => {
      release = () => resolve(createSuccessfulResult());
    });
    const run = vi.fn(() => firstProcess);
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );
    const target = { kind: 'application' as const, application: 'claude-desktop' as const };
    const first = navigator.navigate(target);
    await expect(navigator.navigate(target)).resolves.toEqual({
      status: 'failed',
      target: 'application',
      reason: 'busy',
    });
    release();
    await expect(first).resolves.toEqual({
      status: 'dispatched',
      target: 'application',
      application: 'claude-desktop',
    });
  });

  it('bounds output and cleans up a timed-out owned child process', async () => {
    const output = await runNavigationProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(20000))"],
      {
        timeoutMs: 2_000,
        maxOutputBytes: 128,
      },
    );
    expect(output).toMatchObject({ exitCode: 0, hasTimedOut: false, isCleanupConfirmed: true });
    expect(Buffer.byteLength(output.stdout)).toBe(128);

    const combined = await runNavigationProcess(
      process.execPath,
      ['-e', "process.stdout.write('o'.repeat(100)); process.stderr.write('e'.repeat(100))"],
      { timeoutMs: 2_000, maxOutputBytes: 128 },
    );
    expect(combined).toMatchObject({ exitCode: 0, hasTimedOut: false, isCleanupConfirmed: true });
    expect(Buffer.byteLength(combined.stdout) + Buffer.byteLength(combined.stderr)).toBe(128);

    const fractional = await runNavigationProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(4))"],
      {
        timeoutMs: 2_000,
        maxOutputBytes: 0.5,
      },
    );
    expect(fractional).toMatchObject({ exitCode: 0, hasTimedOut: false, isCleanupConfirmed: true });
    expect(Buffer.byteLength(fractional.stdout)).toBe(1);

    const timeout = await runNavigationProcess(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)'],
      {
        timeoutMs: 50,
        maxOutputBytes: 128,
      },
    );
    expect(timeout.hasTimedOut).toBe(true);
  });

  it('normalizes fractional and non-finite process limits to bounded values', () => {
    expect(normalizeProcessOptions({ timeoutMs: 0.5, maxOutputBytes: 0.5 })).toEqual({
      timeoutMs: 1,
      maxOutputBytes: 1,
    });
    expect(
      normalizeProcessOptions({ timeoutMs: Number.NaN, maxOutputBytes: Number.POSITIVE_INFINITY }),
    ).toEqual({
      timeoutMs: 2_000,
      maxOutputBytes: 8_192,
    });
  });

  it('waits for normal close and handles process or stream errors without hanging', async () => {
    const delayed = await runNavigationProcess(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10)'],
      {
        timeoutMs: 2_000,
      },
    );
    expect(delayed).toMatchObject({ exitCode: 0, hasTimedOut: false, isCleanupConfirmed: true });

    const missing = await runNavigationProcess('/definitely/missing/open', [], {
      timeoutMs: 2_000,
    });
    expect(missing).toMatchObject({ exitCode: null, hasTimedOut: false, isCleanupConfirmed: true });

    const streamClosed = await runNavigationProcess(
      process.execPath,
      ['-e', 'process.stdout.destroy()'],
      {
        timeoutMs: 2_000,
      },
    );
    expect(streamClosed).toMatchObject({
      exitCode: 0,
      hasTimedOut: false,
      isCleanupConfirmed: true,
    });
  });

  it('retains ownership after a delayed close and blocks a second child', async () => {
    const child = new FakeChild('true');
    const nextChild = new FakeChild('false');
    const children = [child, nextChild];
    let factoryCalls = 0;
    const run = createNavigationProcessRunner(() => {
      factoryCalls += 1;
      const next = children.shift();
      if (next === undefined) throw new Error('unexpected extra child');
      return next as unknown as ChildProcess;
    });

    const first = await run('owned', [], { timeoutMs: 1, maxOutputBytes: 16 });
    expect(first).toMatchObject({ hasTimedOut: true, isCleanupConfirmed: false });
    expect(child.killCalls).toBe(1);
    const blocked = await run('blocked', [], { timeoutMs: 1, maxOutputBytes: 16 });
    expect(blocked).toMatchObject({ isCleanupConfirmed: false });
    expect(factoryCalls).toBe(1);

    child.emit('error', new Error('late process error'));
    child.emit('error', new Error('repeated late process error'));
    child.stdout.emit('error', new Error('late stream error'));
    child.stderr.emit('error', new Error('repeated late stream error'));
    child.emit('close', null);

    const next = run('next', [], { timeoutMs: 100, maxOutputBytes: 16 });
    queueMicrotask(() => nextChild.emit('close', 0));
    await expect(next).resolves.toMatchObject({ exitCode: 0, isCleanupConfirmed: true });
    expect(factoryCalls).toBe(2);
  });

  it.each(['false', 'throw'] as const)('keeps ownership when child kill %s', async (killResult) => {
    const child = new FakeChild(killResult);
    let factoryCalls = 0;
    const run = createNavigationProcessRunner(() => {
      factoryCalls += 1;
      return child as unknown as ChildProcess;
    });

    const result = await run('owned', [], { timeoutMs: 1, maxOutputBytes: 16 });
    expect(result).toMatchObject({ hasTimedOut: true, isCleanupConfirmed: false });
    expect(child.killCalls).toBe(1);
    const blocked = await run('blocked', [], { timeoutMs: 1, maxOutputBytes: 16 });
    expect(blocked.isCleanupConfirmed).toBe(false);
    expect(factoryCalls).toBe(1);
    child.emit('close', null);
  });

  it('maps an unconfirmed process cleanup to an explicit navigation failure', async () => {
    const child = new FakeChild('false');
    const navigator = new MacOsNavigator(
      createNavigationProcessRunner(createFakeFactory(child)),
      vi.fn(() => Promise.resolve()),
      'darwin',
    );
    const target = { kind: 'application' as const, application: 'claude-desktop' as const };
    await expect(navigator.navigate(target)).resolves.toMatchObject({
      status: 'failed',
      reason: 'cleanup-unconfirmed',
    });
    await expect(navigator.navigate(target)).resolves.toMatchObject({
      status: 'failed',
      reason: 'cleanup-unconfirmed',
    });
    child.emit('close', null);
  });
});

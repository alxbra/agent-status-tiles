import { describe, expect, it, vi } from 'vitest';

import {
  MACOS_APPLICATIONS,
  MacOsNavigator,
  normalizeProcessOptions,
  type ProcessResult,
  runNavigationProcess,
} from '../../src/main/navigation/macos-navigator';

const codexId = '019f6b6d-644d-7701-8858-9da6837aaaaa';
const claudeId = '019f6b6d-644d-7701-8858-9da6837aaaab';

function ok(): ProcessResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
}

function runnerFor(result: ProcessResult = ok()) {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const run = vi.fn(async (executable: string, args: readonly string[]) => {
    calls.push({ executable, args: [...args] });
    return result;
  });
  return { calls, run };
}

describe('macOS application navigation', () => {
  it('opens the validated Codex task only after foregrounding Codex', async () => {
    const { calls, run } = runnerFor();
    const pause = vi.fn(() => Promise.resolve());
    const navigator = new MacOsNavigator(run, pause, 'darwin');

    await expect(
      navigator.navigate({
        provider: 'codex',
        surface: 'desktop',
        nativeSessionId: codexId,
        owner: 'codex-desktop',
      }),
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
    const { calls, run } = runnerFor();
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );

    await expect(
      navigator.navigate({
        provider: 'codex',
        surface: 'desktop',
        nativeSessionId: '../../etc/passwd',
        owner: 'codex-desktop',
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'invalid-target' });
    await expect(
      navigator.navigate({
        provider: 'claude',
        surface: 'desktop',
        nativeSessionId: claudeId,
        owner: 'codex-desktop',
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'invalid-target' });
    await expect(
      navigator.navigate({
        provider: 'codex',
        surface: 'desktop',
        nativeSessionId: codexId,
        owner: '__proto__',
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'invalid-target' });
    const inherited = Object.create({
      provider: 'codex',
      surface: 'desktop',
      nativeSessionId: codexId,
      owner: 'codex-desktop',
    });
    await expect(navigator.navigate(inherited)).resolves.toMatchObject({
      status: 'failed',
      reason: 'invalid-target',
    });
    expect(calls).toHaveLength(0);
  });

  it('reports an unsupported platform without attempting activation', async () => {
    const { calls, run } = runnerFor();
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'linux',
    );

    await expect(
      navigator.navigate({
        provider: 'claude',
        surface: 'desktop',
        nativeSessionId: claudeId,
        owner: 'claude-desktop',
      }),
    ).resolves.toEqual({ status: 'failed', target: 'application', reason: 'unsupported-platform' });
    expect(calls).toHaveLength(0);
  });

  it('activates Claude without fabricating a session link', async () => {
    const { calls, run } = runnerFor();
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );

    await expect(
      navigator.navigate({
        provider: 'claude',
        surface: 'desktop',
        nativeSessionId: claudeId,
        owner: 'claude-desktop',
      }),
    ).resolves.toEqual({
      status: 'dispatched',
      target: 'application',
      application: 'claude-desktop',
    });
    expect(calls).toEqual([
      { executable: '/usr/bin/open', args: ['-b', MACOS_APPLICATIONS.claudeDesktop.bundleId] },
    ]);
  });

  it('activates only the selected fixed terminal application', async () => {
    const { calls, run } = runnerFor();
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );

    await expect(
      navigator.navigate({
        provider: 'claude',
        surface: 'cli',
        nativeSessionId: 'session-opaque-id',
        owner: 'ghostty',
      }),
    ).resolves.toEqual({ status: 'dispatched', target: 'application', application: 'ghostty' });
    expect(calls).toEqual([
      { executable: '/usr/bin/open', args: ['-b', MACOS_APPLICATIONS.ghostty.bundleId] },
    ]);
  });

  it('returns a selection-required result for unknown terminal ownership', async () => {
    const { calls, run } = runnerFor();
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );

    await expect(
      navigator.navigate({
        provider: 'codex',
        surface: 'cli',
        nativeSessionId: 'session-opaque-id',
        owner: 'unknown',
      }),
    ).resolves.toMatchObject({
      status: 'selection-required',
      target: 'application',
      reason: 'unknown-owner',
      options: ['terminal', 'ghostty', 'warp', 'iterm2'],
    });
    expect(calls).toHaveLength(0);
  });

  it('reports missing apps and timeouts without exposing process output', async () => {
    const missing = runnerFor({
      exitCode: 1,
      stdout: 'ignored stdout',
      stderr: 'Unable to find application by bundle identifier',
      timedOut: false,
    });
    const navigator = new MacOsNavigator(
      missing.run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );
    await expect(
      navigator.navigate({
        provider: 'claude',
        surface: 'desktop',
        nativeSessionId: claudeId,
        owner: 'claude-desktop',
      }),
    ).resolves.toEqual({
      status: 'failed',
      target: 'application',
      application: 'claude-desktop',
      reason: 'missing-application',
    });

    const timeout = runnerFor({
      exitCode: null,
      stdout: 'secret',
      stderr: 'secret',
      timedOut: true,
    });
    const timedOutNavigator = new MacOsNavigator(
      timeout.run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );
    await expect(
      timedOutNavigator.navigate({
        provider: 'codex',
        surface: 'desktop',
        nativeSessionId: codexId,
        owner: 'codex-desktop',
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'timeout', stage: 'activation' });
  });

  it('does not fall back to another Codex invocation when the link dispatch fails', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const run = vi.fn(async (executable: string, args: readonly string[]) => {
      calls.push({ executable, args: [...args] });
      return calls.length === 1
        ? ok()
        : { exitCode: 1, stdout: '', stderr: 'open failed', timedOut: false };
    });
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );

    await expect(
      navigator.navigate({
        provider: 'codex',
        surface: 'desktop',
        nativeSessionId: codexId,
        owner: 'codex-desktop',
      }),
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
      release = () => resolve(ok());
    });
    const run = vi.fn(() => firstProcess);
    const navigator = new MacOsNavigator(
      run,
      vi.fn(() => Promise.resolve()),
      'darwin',
    );
    const target = {
      provider: 'claude' as const,
      surface: 'desktop' as const,
      nativeSessionId: claudeId,
      owner: 'claude-desktop' as const,
    };
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
        timeoutMs: 1_000,
        maxOutputBytes: 128,
      },
    );
    expect(output.timedOut).toBe(false);
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(128);

    const combined = await runNavigationProcess(
      process.execPath,
      ['-e', "process.stdout.write('o'.repeat(100)); process.stderr.write('e'.repeat(100))"],
      { timeoutMs: 1_000, maxOutputBytes: 128 },
    );
    expect(
      Buffer.byteLength(combined.stdout) + Buffer.byteLength(combined.stderr),
    ).toBeLessThanOrEqual(128);

    const fractional = await runNavigationProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(4))"],
      {
        timeoutMs: 1_000,
        maxOutputBytes: 0.5,
      },
    );
    expect(fractional.timedOut).toBe(false);
    expect(Buffer.byteLength(fractional.stdout)).toBeLessThanOrEqual(1);

    const timeout = await runNavigationProcess(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)'],
      {
        timeoutMs: 50,
        maxOutputBytes: 128,
      },
    );
    expect(timeout.timedOut).toBe(true);
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
        timeoutMs: 250,
      },
    );
    expect(delayed).toMatchObject({ exitCode: 0, timedOut: false });

    const missing = await runNavigationProcess('/definitely/missing/open', [], { timeoutMs: 250 });
    expect(missing).toMatchObject({ exitCode: null, timedOut: false });

    const streamClosed = await runNavigationProcess(
      process.execPath,
      ['-e', 'process.stdout.destroy()'],
      {
        timeoutMs: 250,
      },
    );
    expect(streamClosed.timedOut).toBe(false);
  });
});

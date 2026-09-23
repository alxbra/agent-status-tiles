import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ARCHITECTURES,
  cargoCandidates,
  getCargoBuildArguments,
  getHelperBuildPath,
  parseBuildOptions,
  validateMachOArchitecture,
} from '../../scripts/build-hook-helper.mjs';

const scriptPath = resolve(
  fileURLToPath(new URL('../../scripts/build-hook-helper.mjs', import.meta.url)),
);
const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-status-tiles-packaging-'));
  temporaryDirectories.push(directory);
  return directory;
}

type HelperArch = 'arm64' | 'x64';

function writeMachO(directory: string, arch: HelperArch, fileType = 2, size = 32) {
  const path = join(directory, `${arch}-helper`);
  const header = Buffer.alloc(size);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeInt32LE(ARCHITECTURES[arch].cpuType, 4);
  if (size >= 16) {
    header.writeUInt32LE(fileType, 12);
  }
  writeFileSync(path, header);
  return path;
}

function createBuildFixture() {
  const directory = createTemporaryDirectory();
  const scriptsDirectory = join(directory, 'scripts');
  const manifestDirectory = join(directory, 'crates', 'hook-helper');
  const fakeCargo = join(directory, 'fake-cargo.mjs');
  const cargoLog = join(directory, 'cargo-args.json');
  const staleTargetDirectory = join(directory, 'stale-target');
  const targetRoot = join(directory, 'crates', 'hook-helper', 'target');
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(manifestDirectory, { recursive: true });
  copyFileSync(
    join(projectRoot, 'scripts', 'build-hook-helper.mjs'),
    join(scriptsDirectory, 'build-hook-helper.mjs'),
  );
  writeFileSync(
    join(manifestDirectory, 'Cargo.toml'),
    '[package]\nname = "fixture-hook-helper"\nversion = "0.0.0"\n',
  );
  writeFileSync(
    fakeCargo,
    [
      '#!/usr/bin/env node',
      "import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import process from 'node:process';",
      "if (process.argv[2] === '--version') process.exit(0);",
      'const args = process.argv.slice(2);',
      "const target = args[args.indexOf('--target') + 1];",
      "const targetDirectory = args[args.indexOf('--target-dir') + 1];",
      'writeFileSync(process.env.FAKE_CARGO_LOG, JSON.stringify(args));',
      "const cpuType = target === 'aarch64-apple-darwin' ? 0x0100000c : 0x01000007;",
      'const header = Buffer.alloc(32);',
      'header.writeUInt32LE(0xfeedfacf, 0);',
      'header.writeInt32LE(cpuType, 4);',
      'header.writeUInt32LE(2, 12);',
      "const output = join(targetDirectory, target, 'release', 'hook-helper');",
      "mkdirSync(join(targetDirectory, target, 'release'), { recursive: true });",
      'writeFileSync(output, header);',
      'chmodSync(output, 0o755);',
    ].join('\n'),
  );
  chmodSync(fakeCargo, 0o755);
  return {
    directory,
    buildScript: realpathSync(join(scriptsDirectory, 'build-hook-helper.mjs')),
    fakeCargo,
    cargoLog,
    staleTargetDirectory,
    targetRoot,
  };
}

describe('hook-helper packaging contract', () => {
  it('maps only the supported Electron architectures to stable resource paths', () => {
    expect(parseBuildOptions([], {}).architectures).toEqual(['arm64', 'x64']);
    expect(parseBuildOptions(['--arch', 'arm64'], {}).architectures).toEqual(['arm64']);
    expect(parseBuildOptions(['--arch', 'x64'], {}).architectures).toEqual(['x64']);
    expect(parseBuildOptions(['--', '--arch', 'arm64'], {}).architectures).toEqual(['arm64']);
    expect(getHelperBuildPath('arm64')).toBe(
      join(projectRoot, 'build', 'hook-helper', 'arm64', 'hook-helper'),
    );
    expect(getHelperBuildPath('x64')).toBe(
      join(projectRoot, 'build', 'hook-helper', 'x64', 'hook-helper'),
    );
    expect(() => getHelperBuildPath('__proto__')).toThrow('Unsupported helper architecture');
  });

  it('pins Cargo output to the repository target directory', () => {
    const inheritedTargetDirectory = join(createTemporaryDirectory(), 'stale-target');
    const args = getCargoBuildArguments('aarch64-apple-darwin');

    expect(args.slice(-2)).toEqual([
      '--target-dir',
      join(projectRoot, 'crates', 'hook-helper', 'target'),
    ]);
    expect(args).not.toContain(inheritedTargetDirectory);
  });

  it('builds in an isolated fixture despite an inherited stale target directory', () => {
    const { directory, buildScript, fakeCargo, cargoLog, staleTargetDirectory, targetRoot } =
      createBuildFixture();

    const result = spawnSync(
      process.execPath,
      [buildScript, '--arch', 'arm64', '--cargo', fakeCargo],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          CARGO_TARGET_DIR: staleTargetDirectory,
          FAKE_CARGO_LOG: cargoLog,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(
      readFileSync(join(directory, 'build', 'hook-helper', 'arm64', 'hook-helper')),
    ).toHaveLength(32);
    const cargoArgs = JSON.parse(readFileSync(cargoLog, 'utf8')) as string[];
    expect(cargoArgs.slice(-2)).toEqual(['--target-dir', realpathSync(targetRoot)]);
    expect(() => readFileSync(join(staleTargetDirectory, 'aarch64-apple-darwin'))).toThrow();
  });

  it('refuses a symlinked build parent without touching its external contents', () => {
    const { directory, buildScript, fakeCargo } = createBuildFixture();
    const externalDirectory = createTemporaryDirectory();
    const externalHelperDirectory = join(externalDirectory, 'hook-helper');
    const sentinelPath = join(externalHelperDirectory, 'sentinel');
    mkdirSync(externalHelperDirectory, { recursive: true });
    writeFileSync(sentinelPath, 'preserve-me');
    symlinkSync(externalDirectory, join(directory, 'build'), 'dir');

    const result = spawnSync(
      process.execPath,
      [buildScript, '--arch', 'arm64', '--cargo', fakeCargo],
      { cwd: directory, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing unsafe helper output parent');
    expect(readFileSync(sentinelPath, 'utf8')).toBe('preserve-me');
  });

  it('fails beforePack for missing or wrong-architecture helpers in an isolated fixture', () => {
    const directory = createTemporaryDirectory();
    const scriptsDirectory = join(directory, 'scripts');
    const helperDirectory = join(directory, 'build', 'hook-helper', 'arm64');
    const validatorPath = join(scriptsDirectory, 'validate-hook-helper-pack.mjs');
    const runnerPath = join(directory, 'run-validator.mjs');
    mkdirSync(scriptsDirectory, { recursive: true });
    copyFileSync(
      join(projectRoot, 'scripts', 'build-hook-helper.mjs'),
      join(scriptsDirectory, 'build-hook-helper.mjs'),
    );
    copyFileSync(join(projectRoot, 'scripts', 'validate-hook-helper-pack.mjs'), validatorPath);
    writeFileSync(
      runnerPath,
      [
        "import validateHookHelperForPack from './scripts/validate-hook-helper-pack.mjs';",
        "validateHookHelperForPack({ electronPlatformName: 'darwin', arch: 3 });",
      ].join('\n'),
    );

    const missing = spawnSync(process.execPath, [runnerPath], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Cargo did not produce hook-helper for arm64');

    mkdirSync(helperDirectory, { recursive: true });
    const wrongArchitecture = Buffer.alloc(32);
    wrongArchitecture.writeUInt32LE(0xfeedfacf, 0);
    wrongArchitecture.writeInt32LE(ARCHITECTURES.x64.cpuType, 4);
    wrongArchitecture.writeUInt32LE(2, 12);
    const helperPath = join(helperDirectory, 'hook-helper');
    writeFileSync(helperPath, wrongArchitecture);
    chmodSync(helperPath, 0o755);

    const wrong = spawnSync(process.execPath, [runnerPath], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('Built helper architecture mismatch: expected arm64');
  });

  it('rejects malformed build options and unsupported architectures', () => {
    expect(() => parseBuildOptions(['--arch', 'ia32'], {})).toThrow(
      '--arch must be arm64, x64, both, or host',
    );
    expect(() => parseBuildOptions(['--arch', 'host'], {}, 'ia32')).toThrow(
      "This Mac's architecture has no hook-helper",
    );
    expect(() => parseBuildOptions(['--cargo'], {})).toThrow('--cargo requires an executable path');
    expect(() => parseBuildOptions(['--unknown'], {})).toThrow('Unknown argument');
    expect(() => getHelperBuildPath('__proto__')).toThrow('Unsupported helper architecture');
  });

  it('checks each copied helper for a 64-bit Mach-O CPU type', () => {
    const directory = createTemporaryDirectory();
    const arm64Binary = writeMachO(directory, 'arm64');
    const x64Binary = writeMachO(directory, 'x64');

    expect(() => validateMachOArchitecture(arm64Binary, 'arm64')).not.toThrow();
    expect(() => validateMachOArchitecture(x64Binary, 'x64')).not.toThrow();
    expect(() => validateMachOArchitecture(arm64Binary, 'x64')).toThrow(
      'Built helper architecture mismatch: expected x64',
    );
    expect(() => validateMachOArchitecture(join(directory, 'missing'), 'arm64')).toThrow(
      'Unable to read built helper for arm64',
    );

    const truncated = writeMachO(directory, 'arm64', 2, 8);
    expect(() => validateMachOArchitecture(truncated, 'arm64')).toThrow(
      'truncated 64-bit Mach-O header',
    );
    const dylib = writeMachO(directory, 'arm64', 6);
    expect(() => validateMachOArchitecture(dylib, 'arm64')).toThrow(
      'not an executable Mach-O image',
    );
  });

  it('rejects non-Mach-O output instead of packaging an arbitrary executable', () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, 'not-a-helper');
    writeFileSync(path, Buffer.alloc(32, 0x2a));
    chmodSync(path, 0o755);

    expect(() => validateMachOArchitecture(path, 'arm64')).toThrow(
      'not a 64-bit macOS Mach-O executable',
    );
  });

  it('builds only the host architecture and parses the development flags', () => {
    expect(parseBuildOptions(['--arch', 'host'], {}, 'arm64')).toMatchObject({
      arch: 'arm64',
      architectures: ['arm64'],
      cargoPath: 'cargo',
      cargoExplicit: false,
      ifMissing: false,
      optional: false,
    });
    expect(
      parseBuildOptions(['--arch', 'host', '--if-missing', '--optional'], {}, 'x64'),
    ).toMatchObject({ architectures: ['x64'], ifMissing: true, optional: true });
    expect(parseBuildOptions([], { HOOK_HELPER_CARGO: '/opt/cargo' })).toMatchObject({
      cargoPath: '/opt/cargo',
      cargoExplicit: true,
    });
    expect(parseBuildOptions(['--cargo', '/opt/cargo'], {})).toMatchObject({
      cargoExplicit: true,
    });
  });

  it('looks for Cargo on PATH, in the rustup proxies, then in stable toolchains', () => {
    expect(cargoCandidates({}, '/Users/dev')).toEqual([
      'cargo',
      '/Users/dev/.cargo/bin/cargo',
      '/Users/dev/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo',
      '/Users/dev/.rustup/toolchains/stable-x86_64-apple-darwin/bin/cargo',
    ]);
    expect(cargoCandidates({ CARGO_HOME: '/c', RUSTUP_HOME: '/r' }, '/Users/dev')).toEqual([
      'cargo',
      '/c/bin/cargo',
      '/r/toolchains/stable-aarch64-apple-darwin/bin/cargo',
      '/r/toolchains/stable-x86_64-apple-darwin/bin/cargo',
    ]);
  });

  it('finds a stable rustup toolchain Cargo that is not on PATH', () => {
    const { directory, buildScript, fakeCargo, cargoLog } = createBuildFixture();
    const home = join(directory, 'home');
    const toolchainBin = join(home, '.rustup', 'toolchains', 'stable-aarch64-apple-darwin', 'bin');
    mkdirSync(toolchainBin, { recursive: true });
    copyFileSync(fakeCargo, join(toolchainBin, 'cargo'));
    chmodSync(join(toolchainBin, 'cargo'), 0o755);

    const result = spawnSync(process.execPath, [buildScript, '--arch', 'arm64'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        HOME: home,
        // Only Node.js, so neither a real Cargo nor a rustup proxy is reachable.
        PATH: dirname(process.execPath),
        FAKE_CARGO_LOG: cargoLog,
      },
    });

    expect(result.status).toBe(0);
    expect(
      readFileSync(join(directory, 'build', 'hook-helper', 'arm64', 'hook-helper')),
    ).toHaveLength(32);
  });

  it('skips a valid helper with --if-missing and only warns with --optional', () => {
    const { directory, buildScript, fakeCargo, cargoLog } = createBuildFixture();
    const env = { ...process.env, FAKE_CARGO_LOG: cargoLog };
    const build = (...args: string[]) =>
      spawnSync(process.execPath, [buildScript, '--arch', 'arm64', ...args], {
        cwd: directory,
        encoding: 'utf8',
        env,
      });
    const missingCargo = join(directory, 'cargo-not-installed');

    const optionalFailure = build('--cargo', missingCargo, '--optional');
    expect(optionalFailure.status).toBe(0);
    expect(optionalFailure.stderr).toContain('hook-helper was not built');
    expect(optionalFailure.stderr).toContain('pnpm build:hook-helper');

    expect(build('--cargo', fakeCargo).status).toBe(0);
    rmSync(cargoLog);
    const skipped = build('--cargo', missingCargo, '--if-missing');
    expect(skipped.status).toBe(0);
    expect(() => readFileSync(cargoLog)).toThrow();
  });

  it('reports missing Cargo without silently producing a package', () => {
    const missingCargo = join(createTemporaryDirectory(), 'cargo-not-installed');
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--arch', 'arm64', '--cargo', missingCargo],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unable to run Cargo');
  });

  it('configures electron-builder to keep the native resource outside ASAR', () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      build: {
        asar: boolean;
        beforePack: string;
        mac: { extraResources: Array<{ from: string; to: string }> };
      };
    };

    expect(packageJson.build.asar).toBe(true);
    expect(packageJson.build.beforePack).toBe('./scripts/validate-hook-helper-pack.mjs');
    expect(packageJson.build.mac.extraResources).toContainEqual({
      from: 'build/hook-helper',
      to: 'hook-helper',
      filter: ['**/*'],
    });
  });
});

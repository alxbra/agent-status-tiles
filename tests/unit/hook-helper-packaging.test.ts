import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ARCHITECTURES,
  parseBuildOptions,
  resourcePath,
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

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-status-tiles-packaging-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeMachO(directory: string, arch: keyof typeof ARCHITECTURES) {
  const path = join(directory, `${arch}-helper`);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeInt32LE(ARCHITECTURES[arch].cpuType, 4);
  writeFileSync(path, header);
  return path;
}

describe('hook-helper packaging contract', () => {
  it('maps only the supported Electron architectures to stable resource paths', () => {
    expect(parseBuildOptions([], {}).architectures).toEqual(['arm64', 'x64']);
    expect(parseBuildOptions(['--arch', 'arm64'], {}).architectures).toEqual(['arm64']);
    expect(parseBuildOptions(['--arch', 'x64'], {}).architectures).toEqual(['x64']);
    expect(parseBuildOptions(['--', '--arch', 'arm64'], {}).architectures).toEqual(['arm64']);
    expect(resourcePath('arm64')).toBe(join('hook-helper', 'arm64', 'hook-helper'));
    expect(resourcePath('x64')).toBe(join('hook-helper', 'x64', 'hook-helper'));
  });

  it('rejects malformed build options and unsupported architectures', () => {
    expect(() => parseBuildOptions(['--arch', 'ia32'], {})).toThrow(
      '--arch must be arm64, x64, or both',
    );
    expect(() => parseBuildOptions(['--cargo'], {})).toThrow('--cargo requires an executable path');
    expect(() => parseBuildOptions(['--unknown'], {})).toThrow('Unknown argument');
    expect(() => resourcePath('ia32')).toThrow('Unsupported helper architecture');
  });

  it('checks each copied helper for a 64-bit Mach-O CPU type', () => {
    const directory = temporaryDirectory();
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
  });

  it('rejects non-Mach-O output instead of packaging an arbitrary executable', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'not-a-helper');
    writeFileSync(path, 'not a native executable');
    chmodSync(path, 0o755);

    expect(() => validateMachOArchitecture(path, 'arm64')).toThrow(
      'not a 64-bit macOS Mach-O executable',
    );
  });

  it('reports missing Cargo without silently producing a package', () => {
    const missingCargo = join(temporaryDirectory(), 'cargo-not-installed');
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
        mac: { extraResources: Array<{ from: string; to: string }> };
      };
    };

    expect(packageJson.build.asar).toBe(true);
    expect(packageJson.build.mac.extraResources).toContainEqual({
      from: 'build/hook-helper',
      to: 'hook-helper',
      filter: ['**/*'],
    });
  });
});

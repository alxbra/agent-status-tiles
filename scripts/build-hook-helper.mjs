import { spawnSync } from 'node:child_process';
import { Console } from 'node:console';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repositoryRoot, 'crates', 'hook-helper', 'Cargo.toml');
const targetDirectory = join(repositoryRoot, 'crates', 'hook-helper', 'target');
const defaultOutputRoot = join(repositoryRoot, 'build', 'hook-helper');
const logger = new Console(process.stdout, process.stderr);
const MH_EXECUTE = 0x2;
const MACH_HEADER_64_BYTES = 32;

export const ARCHITECTURES = Object.freeze({
  arm64: Object.freeze({ target: 'aarch64-apple-darwin', cpuType: 0x0100000c }),
  x64: Object.freeze({ target: 'x86_64-apple-darwin', cpuType: 0x01000007 }),
});

function isSupportedArchitecture(arch) {
  return typeof arch === 'string' && Object.hasOwn(ARCHITECTURES, arch);
}

const usage = `Usage: node scripts/build-hook-helper.mjs [--arch arm64|x64|both] [--cargo PATH]

Builds the macOS hook-helper resource for the selected Electron architectures.
The default is both supported architectures. Set HOOK_HELPER_CARGO or pass
--cargo when Cargo is not on PATH.`;

export function parseBuildOptions(argv, environment = process.env) {
  let arch = 'both';
  let cargoPath = environment.HOOK_HELPER_CARGO ?? environment.CARGO ?? 'cargo';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--' && index === 0) {
      continue;
    }
    if (argument === '--arch') {
      arch = argv[++index];
      if (!arch || !['arm64', 'x64', 'both'].includes(arch)) {
        throw new Error('--arch must be arm64, x64, or both');
      }
    } else if (argument === '--cargo') {
      cargoPath = argv[++index];
      if (!cargoPath) {
        throw new Error('--cargo requires an executable path');
      }
    } else if (argument !== '--help' && argument !== '-h') {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return {
    arch,
    cargoPath,
    architectures: arch === 'both' ? ['arm64', 'x64'] : [arch],
  };
}

export function getHelperBuildPath(arch) {
  if (!isSupportedArchitecture(arch)) {
    throw new Error(`Unsupported helper architecture: ${arch}`);
  }
  return join(defaultOutputRoot, arch, 'hook-helper');
}

function describeCommandFailure(result, cargoPath, target) {
  if (result.error) {
    return `Unable to run Cargo at ${cargoPath} for ${target}: ${result.error.message}`;
  }
  const details = String(result.stderr ?? '')
    .trim()
    .split('\n')
    .slice(-3)
    .join(' ');
  return `Cargo failed building hook-helper for ${target}${details ? `: ${details}` : ''}`;
}

function runCargo(cargoPath, target) {
  const result = spawnSync(cargoPath, getCargoBuildArguments(target), {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0 || result.error) {
    throw new Error(describeCommandFailure(result, cargoPath, target));
  }
}

export function getCargoBuildArguments(target) {
  return [
    'build',
    '--manifest-path',
    manifestPath,
    '--locked',
    '--release',
    '--target',
    target,
    '--target-dir',
    targetDirectory,
  ];
}

export function validateMachOArchitecture(binaryPath, arch) {
  if (!isSupportedArchitecture(arch)) {
    throw new Error(`Unsupported helper architecture: ${arch}`);
  }
  const architecture = ARCHITECTURES[arch];
  let bytes;
  try {
    bytes = readFileSync(binaryPath);
  } catch (error) {
    throw new Error(`Unable to read built helper for ${arch}: ${error.message}`, { cause: error });
  }
  if (bytes.length < MACH_HEADER_64_BYTES) {
    throw new Error(`Built helper for ${arch} has a truncated 64-bit Mach-O header`);
  }
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`Built helper for ${arch} is not a 64-bit macOS Mach-O executable`);
  }
  const cpuType = bytes.readInt32LE(4);
  if (cpuType !== architecture.cpuType) {
    throw new Error(`Built helper architecture mismatch: expected ${arch}`);
  }
  if (bytes.readUInt32LE(12) !== MH_EXECUTE) {
    throw new Error(`Built helper for ${arch} is not an executable Mach-O image`);
  }
}

function assertRegularExecutable(path, arch) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new Error(`Cargo did not produce hook-helper for ${arch}: ${error.message}`, {
      cause: error,
    });
  }
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error(`Cargo output for ${arch} is not a regular executable file`);
  }
  validateMachOArchitecture(path, arch);
}

export function validateBuiltHelper(arch) {
  const path = getHelperBuildPath(arch);
  assertRegularExecutable(path, arch);
  return path;
}

function clearOutputRoot() {
  const outputRoot = defaultOutputRoot;
  const outputParent = dirname(outputRoot);
  let resolvedParent;
  try {
    const parentMetadata = lstatSync(outputParent);
    if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
      throw new Error(`Refusing unsafe helper output parent: ${outputParent}`);
    }
    resolvedParent = realpathSync(outputParent);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(outputParent, { mode: 0o755 });
    resolvedParent = realpathSync(outputParent);
  }
  const resolvedRepositoryRoot = realpathSync(repositoryRoot);
  if (resolvedParent !== join(resolvedRepositoryRoot, 'build')) {
    throw new Error(`Refusing helper output outside repository: ${outputParent}`);
  }
  try {
    const outputMetadata = lstatSync(outputRoot);
    if (outputMetadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace symlinked helper output: ${outputRoot}`);
    }
    if (!outputMetadata.isDirectory()) {
      throw new Error(`Refusing non-directory helper output: ${outputRoot}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  rmSync(outputRoot, { force: true, recursive: true });
  mkdirSync(outputRoot, { mode: 0o755 });
}

function checkCargo(cargoPath) {
  const result = spawnSync(cargoPath, ['--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0 || result.error) {
    throw new Error(describeCommandFailure(result, cargoPath, 'the configured toolchain'));
  }
}

function buildHookHelper({ cargoPath, architectures }) {
  if (process.platform !== 'darwin') {
    throw new Error('hook-helper packaging supports macOS only');
  }
  if (!lstatSync(manifestPath).isFile()) {
    throw new Error(`Missing hook-helper Cargo manifest: ${manifestPath}`);
  }
  for (const arch of architectures) {
    if (!isSupportedArchitecture(arch)) {
      throw new Error(`Unsupported helper architecture: ${arch}`);
    }
  }
  checkCargo(cargoPath);
  clearOutputRoot();

  for (const arch of architectures) {
    const architecture = ARCHITECTURES[arch];
    runCargo(cargoPath, architecture.target);
    const cargoBinary = join(targetDirectory, architecture.target, 'release', 'hook-helper');
    assertRegularExecutable(cargoBinary, arch);

    const destination = getHelperBuildPath(arch);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    copyFileSync(cargoBinary, destination);
    chmodSync(destination, 0o755);
    assertRegularExecutable(destination, arch);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    logger.log(usage);
    return;
  }
  const options = parseBuildOptions(argv);
  buildHookHelper(options);
  logger.log(`Built hook-helper resources: ${options.architectures.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    logger.error(`hook-helper packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}

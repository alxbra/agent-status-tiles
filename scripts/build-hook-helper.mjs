import { spawnSync } from 'node:child_process';
import { Console } from 'node:console';
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repositoryRoot, 'crates', 'hook-helper', 'Cargo.toml');
const defaultOutputRoot = join(repositoryRoot, 'build', 'hook-helper');
const logger = new Console(process.stdout, process.stderr);

export const ARCHITECTURES = Object.freeze({
  arm64: Object.freeze({ target: 'aarch64-apple-darwin', cpuType: 0x0100000c }),
  x64: Object.freeze({ target: 'x86_64-apple-darwin', cpuType: 0x01000007 }),
});

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

export function resourcePath(arch) {
  if (!(arch in ARCHITECTURES)) {
    throw new Error(`Unsupported helper architecture: ${arch}`);
  }
  return join('hook-helper', arch, 'hook-helper');
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
  const result = spawnSync(
    cargoPath,
    ['build', '--manifest-path', manifestPath, '--locked', '--release', '--target', target],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(describeCommandFailure(result, cargoPath, target));
  }
}

export function validateMachOArchitecture(binaryPath, arch) {
  const architecture = ARCHITECTURES[arch];
  if (!architecture) {
    throw new Error(`Unsupported helper architecture: ${arch}`);
  }
  let bytes;
  try {
    bytes = readFileSync(binaryPath);
  } catch (error) {
    throw new Error(`Unable to read built helper for ${arch}: ${error.message}`, { cause: error });
  }
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`Built helper for ${arch} is not a 64-bit macOS Mach-O executable`);
  }
  const cpuType = bytes.readInt32LE(4);
  if (cpuType !== architecture.cpuType) {
    throw new Error(`Built helper architecture mismatch: expected ${arch}`);
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

function clearOutputRoot(outputRoot) {
  try {
    if (lstatSync(outputRoot).isSymbolicLink()) {
      throw new Error(`Refusing to replace symlinked helper output: ${outputRoot}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  rmSync(outputRoot, { force: true, recursive: true });
  mkdirSync(outputRoot, { recursive: true, mode: 0o755 });
}

export function buildHookHelper({ cargoPath, architectures, outputRoot = defaultOutputRoot }) {
  if (process.platform !== 'darwin') {
    throw new Error('hook-helper packaging supports macOS only');
  }
  if (!lstatSync(manifestPath).isFile()) {
    throw new Error(`Missing hook-helper Cargo manifest: ${manifestPath}`);
  }
  for (const arch of architectures) {
    if (!(arch in ARCHITECTURES)) {
      throw new Error(`Unsupported helper architecture: ${arch}`);
    }
  }
  clearOutputRoot(outputRoot);

  for (const arch of architectures) {
    const architecture = ARCHITECTURES[arch];
    runCargo(cargoPath, architecture.target);
    const cargoBinary = join(
      repositoryRoot,
      'crates',
      'hook-helper',
      'target',
      architecture.target,
      'release',
      'hook-helper',
    );
    assertRegularExecutable(cargoBinary, arch);

    const destination = join(outputRoot, arch, 'hook-helper');
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

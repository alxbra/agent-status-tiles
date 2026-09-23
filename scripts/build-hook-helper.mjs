import { spawnSync } from 'node:child_process';
import { Console } from 'node:console';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

const usage = `Usage: node scripts/build-hook-helper.mjs [--arch arm64|x64|both|host] [--cargo PATH]
       [--if-stale] [--optional]

Builds the macOS hook-helper resource for the selected Electron architectures.
The default is both supported architectures; host builds only this Mac's.
Without HOOK_HELPER_CARGO, CARGO, or --cargo, Cargo is looked up on PATH, in
~/.cargo/bin, and in the stable rustup toolchains.
--if-stale skips the build when a valid helper newer than the Rust sources
is already in place.
--optional reports a failed build as a warning and exits successfully.`;

/** Map `--arch host` to the architecture of the running Node.js process. */
function hostArchitecture(processArch) {
  if (!isSupportedArchitecture(processArch)) {
    throw new Error(`This Mac's architecture has no hook-helper: ${processArch}`);
  }
  return processArch;
}

export function parseBuildOptions(argv, environment = process.env, processArch = process.arch) {
  let arch = 'both';
  const configuredCargo = environment.HOOK_HELPER_CARGO ?? environment.CARGO;
  let cargoPath = configuredCargo ?? 'cargo';
  let cargoExplicit = configuredCargo !== undefined;
  let ifStale = false;
  let optional = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--' && index === 0) {
      continue;
    }
    if (argument === '--arch') {
      arch = argv[++index];
      if (!arch || !['arm64', 'x64', 'both', 'host'].includes(arch)) {
        throw new Error('--arch must be arm64, x64, both, or host');
      }
      if (arch === 'host') arch = hostArchitecture(processArch);
    } else if (argument === '--cargo') {
      cargoPath = argv[++index];
      if (!cargoPath) {
        throw new Error('--cargo requires an executable path');
      }
      cargoExplicit = true;
    } else if (argument === '--if-stale') {
      ifStale = true;
    } else if (argument === '--optional') {
      optional = true;
    } else if (argument !== '--help' && argument !== '-h') {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return {
    arch,
    cargoPath,
    cargoExplicit,
    ifStale,
    optional,
    architectures: arch === 'both' ? ['arm64', 'x64'] : [arch],
  };
}

/**
 * Where to look for Cargo when none is configured: PATH first, then the rustup
 * proxy directory, then the stable toolchains themselves, which rustup
 * installs even when its proxies were never linked onto PATH.
 */
export function cargoCandidates(environment = process.env, home = homedir()) {
  const candidates = ['cargo'];
  if (!home) return candidates;
  candidates.push(join(environment.CARGO_HOME ?? join(home, '.cargo'), 'bin', 'cargo'));
  const toolchains = join(environment.RUSTUP_HOME ?? join(home, '.rustup'), 'toolchains');
  for (const { target } of Object.values(ARCHITECTURES)) {
    candidates.push(join(toolchains, `stable-${target}`, 'bin', 'cargo'));
  }
  return candidates;
}

/** A toolchain Cargo run by absolute path finds its rustc beside it. */
function cargoEnvironment(cargoPath) {
  if (!isAbsolute(cargoPath)) return process.env;
  const path = process.env.PATH ? `${dirname(cargoPath)}:${process.env.PATH}` : dirname(cargoPath);
  return { ...process.env, PATH: path };
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
    env: cargoEnvironment(cargoPath),
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

/** Validate the output root and create it; existing helpers stay until replaced. */
function prepareOutputRoot() {
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
  mkdirSync(outputRoot, { recursive: true, mode: 0o755 });
  // An interrupted install can leave a staged copy; it must never be packaged.
  for (const arch of Object.keys(ARCHITECTURES)) {
    const architectureDirectory = join(outputRoot, arch);
    let entries;
    try {
      entries = readdirSync(architectureDirectory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (/^hook-helper\.\d+\.tmp$/u.test(entry)) {
        rmSync(join(architectureDirectory, entry), { force: true });
      }
    }
  }
}

/**
 * Replace one architecture's helper by renaming a verified copy over it, so
 * installed hooks never see a missing or partial file and the other
 * architecture's helper is left alone.
 */
function installHelper(cargoBinary, arch) {
  const destination = getHelperBuildPath(arch);
  const architectureDirectory = dirname(destination);
  try {
    const metadata = lstatSync(architectureDirectory);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing symlinked helper output: ${architectureDirectory}`);
    }
    if (!metadata.isDirectory()) rmSync(architectureDirectory, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  mkdirSync(architectureDirectory, { recursive: true, mode: 0o755 });
  const staged = `${destination}.${String(process.pid)}.tmp`;
  try {
    copyFileSync(cargoBinary, staged);
    chmodSync(staged, 0o755);
    assertRegularExecutable(staged, arch);
    renameSync(staged, destination);
  } finally {
    rmSync(staged, { force: true });
  }
  assertRegularExecutable(destination, arch);
}

/** The newest modification time among the helper's Rust sources, or 0. */
function newestSourceTime() {
  let newest = 0;
  const visit = (path) => {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch {
      return;
    }
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (metadata.isFile()) {
      newest = Math.max(newest, metadata.mtimeMs);
    }
  };
  for (const source of ['Cargo.toml', 'Cargo.lock', 'src']) {
    visit(join(dirname(manifestPath), source));
  }
  return newest;
}

function cargoVersion(cargoPath) {
  return spawnSync(cargoPath, ['--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: cargoEnvironment(cargoPath),
    stdio: 'pipe',
  });
}

/** Use the configured Cargo as is; otherwise take the first candidate that runs. */
function resolveCargo(cargoPath, cargoExplicit) {
  if (cargoExplicit) {
    const result = cargoVersion(cargoPath);
    if (result.status !== 0 || result.error) {
      throw new Error(describeCommandFailure(result, cargoPath, 'the configured toolchain'));
    }
    return cargoPath;
  }
  for (const candidate of cargoCandidates()) {
    const result = cargoVersion(candidate);
    if (result.status === 0 && !result.error) return candidate;
  }
  throw new Error(
    'Unable to run Cargo: none on PATH, in ~/.cargo/bin, or in a stable rustup toolchain. Set HOOK_HELPER_CARGO or pass --cargo.',
  );
}

/** Valid helpers built after the last change to the Rust sources. */
function helpersInPlace(architectures) {
  const sourcesChangedAt = newestSourceTime();
  try {
    return architectures.every(
      (arch) => lstatSync(validateBuiltHelper(arch)).mtimeMs >= sourcesChangedAt,
    );
  } catch {
    return false;
  }
}

function buildHookHelper({ cargoPath, cargoExplicit, architectures }) {
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
  const cargo = resolveCargo(cargoPath, cargoExplicit);
  prepareOutputRoot();

  for (const arch of architectures) {
    const architecture = ARCHITECTURES[arch];
    runCargo(cargo, architecture.target);
    const cargoBinary = join(targetDirectory, architecture.target, 'release', 'hook-helper');
    assertRegularExecutable(cargoBinary, arch);
    installHelper(cargoBinary, arch);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    logger.log(usage);
    return;
  }
  const options = parseBuildOptions(argv);
  if (options.ifStale && helpersInPlace(options.architectures)) return;
  try {
    buildHookHelper(options);
  } catch (error) {
    if (!options.optional) throw error;
    const kept = options.architectures.every((arch) => {
      try {
        validateBuiltHelper(arch);
        return true;
      } catch {
        return false;
      }
    });
    logger.warn(
      kept
        ? `hook-helper was not rebuilt (${error.message}); the existing helper is older than the Rust sources until \`pnpm build:hook-helper -- --arch host\` succeeds.`
        : `hook-helper was not built (${error.message}); Claude Code cannot connect until \`pnpm build:hook-helper -- --arch host\` succeeds.`,
    );
    return;
  }
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

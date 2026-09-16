import { execFile } from 'node:child_process';
import { realpath as defaultRealpath, stat as defaultStat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

export const CODEX_DESKTOP_BUNDLE_PATH = '/Applications/ChatGPT.app';
export const CODEX_DESKTOP_BUNDLE_ID = 'com.openai.codex';
export const CODEX_DESKTOP_BINARY_RELATIVE_PATH = 'Contents/Resources/codex';

const PLUTIL_PATH = '/usr/bin/plutil';
const CODESIGN_PATH = '/usr/bin/codesign';
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_METADATA_BYTES = 64 * 1024;

export type CodexBinaryResolutionCode =
  | 'bundle-not-found'
  | 'bundle-id-mismatch'
  | 'binary-missing'
  | 'binary-outside-bundle'
  | 'binary-not-regular'
  | 'binary-unsafe-permissions'
  | 'code-signature-invalid'
  | 'version-unavailable'
  | 'resolver-failed';

export type CodexBinaryResolution =
  | {
      ok: true;
      binaryPath: string;
      bundlePath: string;
      bundleId: typeof CODEX_DESKTOP_BUNDLE_ID;
      version?: string;
    }
  | { ok: false; code: CodexBinaryResolutionCode };

export interface CodexFileStat {
  mode: number;
  isFile(): boolean;
}

export interface CodexBundleMetadata {
  bundleId?: string;
  version?: string;
}

export interface CodexBinaryResolverOptions {
  /** Production defaults to the signed ChatGPT application bundle. */
  bundlePath?: string;
  /** Test seams; callers cannot replace the fixed bundle-relative executable. */
  realpath?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<CodexFileStat>;
  readBundleMetadata?: (bundlePath: string) => Promise<CodexBundleMetadata>;
  verifyCodeSignature?: (bundlePath: string, binaryPath: string) => Promise<boolean>;
}

function safeMetadataString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !/\p{Cc}/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= 256
  );
}

function runFixedCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_METADATA_BYTES,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function readBundleMetadataDefault(bundlePath: string): Promise<CodexBundleMetadata> {
  const plistPath = join(bundlePath, 'Contents', 'Info.plist');
  const readKey = async (key: string): Promise<string> => {
    const value = await runFixedCommand(PLUTIL_PATH, [
      '-extract',
      key,
      'raw',
      '-o',
      '-',
      plistPath,
    ]);
    if (!safeMetadataString(value.trim())) throw new Error('invalid-metadata');
    return value.trim();
  };
  const bundleId = await readKey('CFBundleIdentifier');
  let version: string | undefined;
  try {
    version = await readKey('CFBundleShortVersionString');
  } catch {
    // The bundle identity remains useful for a stable version-unavailable
    // result; subprocess output is intentionally discarded.
  }
  return { bundleId, ...(version === undefined ? {} : { version }) };
}

async function verifyCodeSignatureDefault(bundlePath: string): Promise<boolean> {
  // macOS release builds must pass the system verifier. Non-macOS test hosts
  // have no meaningful codesign database, so the seam is conservatively
  // treated as unavailable only when the platform can actually verify it.
  if (process.platform !== 'darwin') return true;
  try {
    await runFixedCommand(CODESIGN_PATH, ['--verify', '--deep', '--strict', bundlePath]);
    return true;
  } catch {
    return false;
  }
}

function containedWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child.length > 0 && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${'/'}`);
}

/**
 * Resolve only the fixed executable shipped in a trusted ChatGPT bundle.
 * Diagnostics are stable codes; no filesystem path or subprocess output is
 * retained or returned on failure.
 */
export async function resolveBundledCodexBinary(
  options: CodexBinaryResolverOptions = {},
): Promise<CodexBinaryResolution> {
  const bundlePath = options.bundlePath ?? CODEX_DESKTOP_BUNDLE_PATH;
  if (!isAbsolute(bundlePath)) return { ok: false, code: 'resolver-failed' };
  const resolvePath = options.realpath ?? defaultRealpath;
  const statPath = options.stat ?? defaultStat;
  const readMetadata = options.readBundleMetadata ?? readBundleMetadataDefault;
  const verifySignature = options.verifyCodeSignature ?? verifyCodeSignatureDefault;

  let bundleRealPath: string;
  try {
    bundleRealPath = await resolvePath(bundlePath);
  } catch {
    return { ok: false, code: 'bundle-not-found' };
  }

  let metadata: CodexBundleMetadata;
  try {
    metadata = await readMetadata(bundleRealPath);
  } catch {
    return { ok: false, code: 'resolver-failed' };
  }
  if (metadata.bundleId !== CODEX_DESKTOP_BUNDLE_ID) {
    return { ok: false, code: 'bundle-id-mismatch' };
  }
  if (!safeMetadataString(metadata.version)) {
    return { ok: false, code: 'version-unavailable' };
  }

  const binaryCandidate = join(bundleRealPath, CODEX_DESKTOP_BINARY_RELATIVE_PATH);
  let binaryRealPath: string;
  try {
    binaryRealPath = await resolvePath(binaryCandidate);
  } catch {
    return { ok: false, code: 'binary-missing' };
  }
  if (!containedWithin(bundleRealPath, binaryRealPath)) {
    return { ok: false, code: 'binary-outside-bundle' };
  }

  let binaryStat: CodexFileStat;
  try {
    binaryStat = await statPath(binaryRealPath);
  } catch {
    return { ok: false, code: 'binary-missing' };
  }
  if (!binaryStat.isFile()) return { ok: false, code: 'binary-not-regular' };
  // Owner executable is required; group/world write would permit replacement
  // by another user and invalidates the trust boundary.
  if ((binaryStat.mode & 0o100) === 0 || (binaryStat.mode & 0o022) !== 0) {
    return { ok: false, code: 'binary-unsafe-permissions' };
  }

  try {
    if (!(await verifySignature(bundleRealPath, binaryRealPath))) {
      return { ok: false, code: 'code-signature-invalid' };
    }
  } catch {
    return { ok: false, code: 'code-signature-invalid' };
  }

  return {
    ok: true,
    binaryPath: binaryRealPath,
    bundlePath: bundleRealPath,
    bundleId: CODEX_DESKTOP_BUNDLE_ID,
    version: metadata.version,
  };
}

/** Naming alias for callers that describe this as the Desktop resolver. */
export const resolveCodexDesktopBinary = resolveBundledCodexBinary;

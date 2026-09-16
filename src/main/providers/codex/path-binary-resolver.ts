import { realpath as defaultRealpath, stat as defaultStat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

const CODEX_EXECUTABLE_NAME = 'codex';
const MAX_PATH_BYTES = 4096;

/** Stable, privacy-safe outcomes for PATH discovery. */
export type CodexPathBinaryResolutionCode =
  | 'path-unavailable'
  | 'binary-missing'
  | 'binary-not-regular'
  | 'binary-unsafe-permissions'
  | 'resolver-failed';

export type CodexPathBinaryResolution =
  { ok: true; binaryPath: string } | { ok: false; code: CodexPathBinaryResolutionCode };

export interface CodexPathFileStat {
  mode: number;
  isFile(): boolean;
}

export interface CodexPathBinaryResolverOptions {
  /** PATH text to inspect; production defaults to the current process PATH. */
  path?: string;
  /** An explicit list is useful to callers that already parsed PATH safely. */
  pathEntries?: readonly string[];
  realpath?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<CodexPathFileStat>;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    utf8Bytes(value) <= MAX_PATH_BYTES &&
    !/\p{Cc}/u.test(value)
  );
}

function pathEntries(options: CodexPathBinaryResolverOptions): readonly string[] {
  if (options.pathEntries !== undefined) {
    return options.pathEntries.filter((entry): entry is string => safePath(entry));
  }
  const value = typeof options.path === 'string' ? options.path : (process.env.PATH ?? '');
  return value.split(delimiter);
}

/**
 * Resolve the `codex` executable without invoking a shell or consulting a
 * command lookup utility. Only absolute PATH entries are considered. Every
 * accepted candidate is canonicalized before its type and mode are checked,
 * so a symlink to the same bundled executable is treated as that executable.
 *
 * Failure values deliberately contain only fixed codes; filesystem paths and
 * underlying errors never cross this boundary.
 */
export async function resolvePathCodexBinary(
  options: CodexPathBinaryResolverOptions = {},
): Promise<CodexPathBinaryResolution> {
  const entries = pathEntries(options);
  const candidates = entries.filter((entry) => safePath(entry) && isAbsolute(entry));
  if (candidates.length === 0) return { ok: false, code: 'path-unavailable' };

  const resolvePath = options.realpath ?? defaultRealpath;
  const statPath = options.stat ?? defaultStat;
  let foundCandidate = false;

  for (const entry of candidates) {
    const candidate = join(entry, CODEX_EXECUTABLE_NAME);
    let binaryPath: string;
    try {
      binaryPath = await resolvePath(candidate);
    } catch {
      continue;
    }
    // realpath(3) normally guarantees an absolute path. Keep that invariant
    // even for test seams or unusual filesystem implementations.
    if (!safePath(binaryPath) || !isAbsolute(binaryPath)) continue;
    foundCandidate = true;

    let binaryStat: CodexPathFileStat;
    let directoryStat: CodexPathFileStat;
    try {
      binaryStat = await statPath(binaryPath);
      directoryStat = await statPath(dirname(binaryPath));
    } catch {
      // A PATH candidate may disappear between realpath and stat. Continue
      // with the next absolute entry just as command lookup would.
      continue;
    }
    if (
      binaryStat === null ||
      typeof binaryStat !== 'object' ||
      typeof binaryStat.isFile !== 'function' ||
      !Number.isSafeInteger(binaryStat.mode) ||
      directoryStat === null ||
      typeof directoryStat !== 'object' ||
      !Number.isSafeInteger(directoryStat.mode)
    ) {
      return { ok: false, code: 'resolver-failed' };
    }
    if (!binaryStat.isFile()) return { ok: false, code: 'binary-not-regular' };
    // Owner execution is required. Group/world write would allow a different
    // account to replace the executable behind the trusted PATH entry.
    if (
      (binaryStat.mode & 0o100) === 0 ||
      (binaryStat.mode & 0o022) !== 0 ||
      (directoryStat.mode & 0o022) !== 0
    ) {
      return { ok: false, code: 'binary-unsafe-permissions' };
    }
    return { ok: true, binaryPath };
  }

  return {
    ok: false,
    code: foundCandidate ? 'resolver-failed' : 'binary-missing',
  };
}

/** Naming alias for callers that use the shorter PATH-resolver description. */
export const resolveCodexPathBinary = resolvePathCodexBinary;

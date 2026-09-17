import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Electron architectures that ship a bundled helper; see `docs/hook-helper.md`. */
const HELPER_ARCHITECTURES = new Set(['arm64', 'x64']);
const OWNER_EXECUTE_BIT = 0o100;

export type HookHelperPathCode =
  | 'unsupported-architecture'
  | 'helper-missing'
  | 'helper-not-regular'
  | 'helper-not-executable'
  | 'resolver-failed';

export type HookHelperPathResolution =
  { ok: true; path: string } | { ok: false; code: HookHelperPathCode };

export interface HookHelperPathOptions {
  /** `app.isPackaged`; packaged builds carry the helper as an app resource. */
  isPackaged: boolean;
  /** `process.resourcesPath` when packaged. */
  resourcesPath: string;
  /** Repository root in development, where `pnpm build:hook-helper` writes. */
  appRoot: string;
  /** `process.arch`. */
  arch: string;
  lstat?: (path: string) => { isSymbolicLink(): boolean; isFile(): boolean; mode: number };
}

/**
 * Locate the bundled `hook-helper` executable for this machine. The result is
 * the absolute path written into the user's Claude hook configuration, so it
 * must be a regular, owner-executable file and never a symlink.
 */
export function resolveHookHelperPath(options: HookHelperPathOptions): HookHelperPathResolution {
  if (!HELPER_ARCHITECTURES.has(options.arch)) {
    return { ok: false, code: 'unsupported-architecture' };
  }
  const root = options.isPackaged
    ? join(options.resourcesPath, 'hook-helper')
    : join(options.appRoot, 'build', 'hook-helper');
  const path = join(root, options.arch, 'hook-helper');
  if (!isAbsolute(path)) return { ok: false, code: 'resolver-failed' };
  let metadata: ReturnType<NonNullable<HookHelperPathOptions['lstat']>>;
  try {
    metadata = (options.lstat ?? lstatSync)(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ok: false, code: code === 'ENOENT' ? 'helper-missing' : 'resolver-failed' };
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return { ok: false, code: 'helper-not-regular' };
  }
  if ((metadata.mode & OWNER_EXECUTE_BIT) === 0) {
    return { ok: false, code: 'helper-not-executable' };
  }
  return { ok: true, path };
}

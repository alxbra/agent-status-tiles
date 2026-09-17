import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveHookHelperPath } from '../../src/main/providers/claude/helper-path';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-status-tiles-helper-path-'));
  roots.push(directory);
  return directory;
}

async function writeHelper(directory: string, arch: string, mode = 0o755): Promise<string> {
  const helperDirectory = join(directory, 'hook-helper', arch);
  await mkdir(helperDirectory, { recursive: true });
  const path = join(helperDirectory, 'hook-helper');
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, mode);
  return path;
}

describe('hook helper path', () => {
  it('resolves the packaged resource and the development build for supported architectures', async () => {
    const resources = await root();
    const packaged = await writeHelper(resources, 'arm64');
    expect(
      resolveHookHelperPath({
        isPackaged: true,
        resourcesPath: resources,
        appRoot: '/x',
        arch: 'arm64',
      }),
    ).toEqual({ ok: true, path: packaged });

    const appRoot = await root();
    const built = await writeHelper(join(appRoot, 'build'), 'x64');
    expect(
      resolveHookHelperPath({ isPackaged: false, resourcesPath: '/x', appRoot, arch: 'x64' }),
    ).toEqual({ ok: true, path: built });
  });

  it('rejects unsupported architectures, missing, symlinked, and non-executable helpers', async () => {
    const resources = await root();
    const options = { isPackaged: true, resourcesPath: resources, appRoot: '/x' };
    expect(resolveHookHelperPath({ ...options, arch: 'ia32' })).toEqual({
      ok: false,
      code: 'unsupported-architecture',
    });
    expect(resolveHookHelperPath({ ...options, arch: '__proto__' })).toEqual({
      ok: false,
      code: 'unsupported-architecture',
    });
    expect(resolveHookHelperPath({ ...options, arch: 'arm64' })).toEqual({
      ok: false,
      code: 'helper-missing',
    });

    await writeHelper(resources, 'x64', 0o644);
    expect(resolveHookHelperPath({ ...options, arch: 'x64' })).toEqual({
      ok: false,
      code: 'helper-not-executable',
    });

    const real = await writeHelper(resources, 'x64-real');
    await rm(join(resources, 'hook-helper', 'arm64'), { recursive: true, force: true });
    await mkdir(join(resources, 'hook-helper', 'arm64'), { recursive: true });
    await symlink(real, join(resources, 'hook-helper', 'arm64', 'hook-helper'));
    expect(resolveHookHelperPath({ ...options, arch: 'arm64' })).toEqual({
      ok: false,
      code: 'helper-not-regular',
    });
  });
});

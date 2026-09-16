import { describe, expect, it } from 'vitest';

import {
  resolvePathCodexBinary,
  type CodexPathBinaryResolverOptions,
  type CodexPathFileStat,
} from '../../src/main/providers/codex/path-binary-resolver';

const entry = '/private/user/bin';
const candidate = `${entry}/codex`;
const canonical = '/Applications/ChatGPT.app/Contents/Resources/codex';

function options(overrides: Partial<CodexPathBinaryResolverOptions> = {}) {
  const stats = new Map<string, CodexPathFileStat>([
    [canonical, { mode: 0o100755, isFile: () => true }],
    ['/Applications/ChatGPT.app/Contents/Resources', { mode: 0o40755, isFile: () => false }],
  ]);
  return {
    path: entry,
    realpath: async (path: string) => (path === candidate ? canonical : path),
    stat: async (path: string) => {
      const value = stats.get(path);
      if (value === undefined) throw new Error('missing');
      return value;
    },
    ...overrides,
  } satisfies CodexPathBinaryResolverOptions;
}

describe('PATH Codex binary resolver', () => {
  it('uses only absolute PATH entries and returns a canonical symlink target', async () => {
    const calls: string[] = [];
    const result = await resolvePathCodexBinary(
      options({
        path: `relative${':'}${':'}${entry}`,
        realpath: async (path) => {
          calls.push(path);
          return path === candidate ? canonical : path;
        },
      }),
    );

    expect(result).toEqual({ ok: true, binaryPath: canonical });
    expect(calls).toEqual([candidate]);
  });

  it('rejects a missing PATH and does not expose path details in failures', async () => {
    await expect(resolvePathCodexBinary({ path: `relative${':'}also-relative` })).resolves.toEqual({
      ok: false,
      code: 'path-unavailable',
    });

    const result = await resolvePathCodexBinary(
      options({
        realpath: async () => {
          throw new Error('/private/user/secret/codex');
        },
      }),
    );
    expect(result).toEqual({ ok: false, code: 'binary-missing' });
    expect(JSON.stringify(result)).not.toContain('/private/user/secret');
  });

  it('requires a regular owner-executable with no group/world write bits', async () => {
    await expect(
      resolvePathCodexBinary(
        options({ stat: async () => ({ mode: 0o100755, isFile: () => false }) }),
      ),
    ).resolves.toEqual({ ok: false, code: 'binary-not-regular' });
    await expect(
      resolvePathCodexBinary(
        options({ stat: async () => ({ mode: 0o100644, isFile: () => true }) }),
      ),
    ).resolves.toEqual({ ok: false, code: 'binary-unsafe-permissions' });
    await expect(
      resolvePathCodexBinary(
        options({ stat: async () => ({ mode: 0o100775, isFile: () => true }) }),
      ),
    ).resolves.toEqual({ ok: false, code: 'binary-unsafe-permissions' });
  });

  it('does not invoke a shell or silently fall through an unsafe first match', async () => {
    const paths = ['/private/user/bin', '/usr/local/bin'];
    const result = await resolvePathCodexBinary(
      options({
        pathEntries: paths,
        realpath: async (path) => path,
        stat: async () => ({ mode: 0o100755 | 0o002, isFile: () => true }),
      }),
    );
    expect(result).toEqual({ ok: false, code: 'binary-unsafe-permissions' });
  });

  it('rejects a writable resolved executable directory', async () => {
    const result = await resolvePathCodexBinary(
      options({
        stat: async (path) => ({
          mode: path === canonical ? 0o100755 : 0o40775,
          isFile: () => path === canonical,
        }),
      }),
    );
    expect(result).toEqual({ ok: false, code: 'binary-unsafe-permissions' });
  });
});

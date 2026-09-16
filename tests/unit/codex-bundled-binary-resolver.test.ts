import { describe, expect, it } from 'vitest';

import {
  CODEX_DESKTOP_BUNDLE_ID,
  CODEX_DESKTOP_BINARY_RELATIVE_PATH,
  resolveBundledCodexBinary,
  type CodexBinaryResolverOptions,
  type CodexFileStat,
} from '../../src/main/providers/codex/bundled-binary-resolver';

const bundle = '/tmp/ChatGPT.app';
const binary = `${bundle}/${CODEX_DESKTOP_BINARY_RELATIVE_PATH}`;

function options(overrides: Partial<CodexBinaryResolverOptions> = {}): CodexBinaryResolverOptions {
  const stats = new Map<string, CodexFileStat>([[binary, { mode: 0o100755, isFile: () => true }]]);
  return {
    bundlePath: bundle,
    realpath: async (path) => path,
    stat: async (path) => {
      const value = stats.get(path);
      if (value === undefined) throw new Error('missing');
      return value;
    },
    readBundleMetadata: async () => ({ bundleId: CODEX_DESKTOP_BUNDLE_ID, version: '1.2.3' }),
    verifyCodeSignature: async () => true,
    ...overrides,
  };
}

describe('bundled Codex binary resolver', () => {
  it('returns only the fixed executable inside the verified bundle', async () => {
    await expect(resolveBundledCodexBinary(options())).resolves.toEqual({
      ok: true,
      binaryPath: binary,
      bundlePath: bundle,
      bundleId: CODEX_DESKTOP_BUNDLE_ID,
      version: '1.2.3',
    });
  });

  it('rejects bundle identity, missing version, and signature failures', async () => {
    await expect(
      resolveBundledCodexBinary(
        options({ readBundleMetadata: async () => ({ bundleId: 'com.other.app', version: '1' }) }),
      ),
    ).resolves.toEqual({ ok: false, code: 'bundle-id-mismatch' });
    await expect(
      resolveBundledCodexBinary(
        options({ readBundleMetadata: async () => ({ bundleId: CODEX_DESKTOP_BUNDLE_ID }) }),
      ),
    ).resolves.toEqual({ ok: false, code: 'version-unavailable' });
    await expect(
      resolveBundledCodexBinary(options({ verifyCodeSignature: async () => false })),
    ).resolves.toEqual({ ok: false, code: 'code-signature-invalid' });
  });

  it('rejects escapes, non-regular files, and unsafe permissions', async () => {
    await expect(
      resolveBundledCodexBinary(
        options({
          realpath: async (path) => (path === binary ? '/tmp/outside/codex' : path),
        }),
      ),
    ).resolves.toEqual({ ok: false, code: 'binary-outside-bundle' });
    await expect(
      resolveBundledCodexBinary(
        options({ stat: async () => ({ mode: 0o100755, isFile: () => false }) }),
      ),
    ).resolves.toEqual({ ok: false, code: 'binary-not-regular' });
    await expect(
      resolveBundledCodexBinary(
        options({ stat: async () => ({ mode: 0o100775, isFile: () => true }) }),
      ),
    ).resolves.toEqual({ ok: false, code: 'binary-unsafe-permissions' });
  });

  it('does not include private paths or subprocess output in failures', async () => {
    const result = await resolveBundledCodexBinary(
      options({
        readBundleMetadata: async () => {
          throw new Error(`/private/user/secret/${binary}`);
        },
      }),
    );
    expect(result).toEqual({ ok: false, code: 'resolver-failed' });
    expect(JSON.stringify(result)).not.toContain('/private/user/secret');
  });
});

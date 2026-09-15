import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CodexCatalogClient,
  type CodexCatalogDiagnosticCode,
} from '../../src/main/providers/codex/catalog-client';

const temporaryDirectories: string[] = [];

const topLevelThread = {
  id: '11111111-1111-7111-8111-111111111111',
  sessionId: '11111111-1111-7111-8111-111111111111',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  recencyAt: 1_700_000_101,
  cwd: '/Users/alex/Projects/demo-app',
  path: '/Users/alex/.codex/sessions/2026/01/01/rollout.jsonl',
  cliVersion: '0.154.0-alpha.6.2',
  modelProvider: 'openai',
  status: { type: 'idle' },
  source: 'cli',
  threadSource: null,
  originator: 'codex_cli_rs',
  parentThreadId: null,
  forkedFromId: null,
  projectId: 'project-1',
  ephemeral: false,
  preview: 'PRIVATE_PROMPT_MUST_NOT_ESCAPE',
  name: 'PRIVATE_NAME_MUST_NOT_ESCAPE',
  turns: [{ id: 'private-turn-content' }],
};

const appServerThread = {
  ...topLevelThread,
  id: '22222222-2222-7222-8222-222222222222',
  sessionId: '22222222-2222-7222-8222-222222222222',
  source: 'appServer',
  updatedAt: 1_700_000_200,
};

const childThread = {
  ...topLevelThread,
  id: '33333333-3333-7333-8333-333333333333',
  sessionId: '33333333-3333-7333-8333-333333333333',
  source: { subAgent: 'review' },
  parentThreadId: topLevelThread.id,
  updatedAt: 1_700_000_300,
};

const ephemeralThread = {
  ...topLevelThread,
  id: '44444444-4444-7444-8444-444444444444',
  sessionId: '44444444-4444-7444-8444-444444444444',
  ephemeral: true,
  updatedAt: 1_700_000_400,
};

async function createFakeBinary(mode: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-status-tiles-codex-catalog-'));
  temporaryDirectories.push(directory);
  const binaryPath = join(directory, 'codex');
  const pages = JSON.stringify([
    { data: [topLevelThread, childThread], nextCursor: 'page-2' },
    { data: [appServerThread, ephemeralThread], nextCursor: null },
  ]);
  const script = `#!/usr/bin/env node
const mode = ${JSON.stringify(mode)};
const pages = ${pages};
let carry = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  carry += chunk;
  let newline;
  while ((newline = carry.indexOf('\\n')) >= 0) {
    const line = carry.slice(0, newline);
    carry = carry.slice(newline + 1);
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.method === 'initialize') {
      if (mode === 'stderr') process.stderr.write('PRIVATE_SERVER_ERROR');
      if (mode === 'malformed-initialize') {
        process.stdout.write(JSON.stringify({ id: request.id, result: null }) + '\\n');
        continue;
      }
      if (mode === 'slow-start') {
        setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, result: {
          codexHome: '/tmp/fake-codex-home', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake'
        }}) + '\\n'), 200);
      } else {
        process.stdout.write(JSON.stringify({ id: request.id, result: {
          codexHome: '/tmp/fake-codex-home', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake'
        }}) + '\\n');
      }
      continue;
    }
    if (request.method !== 'thread/list') continue;
    if (mode === 'delay') continue;
    if (mode === 'oversized') {
      process.stdout.write('x'.repeat(1024 * 1024 + 1) + '\\n');
      continue;
    }
    if (mode === 'malformed-result') {
      process.stdout.write(JSON.stringify({ id: request.id, result: { data: 'not-an-array' }}) + '\\n');
      continue;
    }
    if (mode === 'protocol-error') {
      process.stdout.write(JSON.stringify({ id: request.id, error: { message: 'PRIVATE_SERVER_ERROR' }}) + '\\n');
      continue;
    }
    if (mode === 'malformed-json') {
      process.stdout.write('{not-json\\n');
      continue;
    }
    if (mode === 'exit') { process.exit(0); }
    const page = request.params.cursor === null ? pages[0] : pages[1];
    const outputPage = { ...page, data: page.data.slice(0, request.params.limit) };
    if (mode === 'unsupported-record') outputPage.data[0] = { ...outputPage.data[0], source: 'ambiguous' };
    if (mode === 'repeated-cursor') outputPage.nextCursor = 'page-2';
    process.stdout.write(JSON.stringify({ id: request.id, result: outputPage }) + '\\n');
  }
});
`;
  await writeFile(binaryPath, script, 'utf8');
  await chmod(binaryPath, 0o700);
  return binaryPath;
}

function createClient(
  binaryPath: string,
  diagnostics: CodexCatalogDiagnosticCode[],
  timeoutMs = 2_000,
): CodexCatalogClient {
  return new CodexCatalogClient({
    binaryPath,
    codexHome: join(tmpdir(), 'codex-home-fixture'),
    requestTimeoutMs: timeoutMs,
    onDiagnostic: ({ code }) => diagnostics.push(code),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Codex catalog client', () => {
  it('completes the supported handshake and paginates a metadata-only projection', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('pagination'), diagnostics);

    const result = await client.listThreads({ pageSize: 2, maxPages: 2, maxRecords: 8 });

    expect(result.pagesRead).toBe(2);
    expect(result.nextCursor).toBeNull();
    expect(result.records).toHaveLength(4);
    expect(result.records[0]).toMatchObject({
      nativeId: topLevelThread.id,
      sessionId: topLevelThread.sessionId,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      recencyAt: 1_700_000_101_000,
      projectBasename: 'demo-app',
      rolloutPath: topLevelThread.path,
      isEphemeral: false,
      isTopLevel: true,
      sourceEvidence: {
        source: 'cli',
        originator: 'codex_cli_rs',
        cliVersion: '0.154.0-alpha.6.2',
        isSubAgent: false,
      },
    });
    expect(result.records[1]).toMatchObject({
      nativeId: childThread.id,
      parentThreadId: topLevelThread.id,
      isTopLevel: false,
      sourceEvidence: { source: 'subAgentReview', isSubAgent: true },
    });
    expect(result.records[2]).toMatchObject({
      nativeId: appServerThread.id,
      isTopLevel: true,
      sourceEvidence: { source: 'appServer' },
    });
    expect(result.records[3]).toMatchObject({ nativeId: ephemeralThread.id, isEphemeral: true });
    expect(result.records[0]).not.toHaveProperty('preview');
    expect(result.records[0]).not.toHaveProperty('name');
    expect(result.records[0]).not.toHaveProperty('turns');
    expect(JSON.stringify(result.records)).not.toContain('PRIVATE_');
    expect(diagnostics).toEqual([]);

    await client.stop();
    expect(client.connected).toBe(false);
  });

  it('returns a bounded continuation cursor when page or record limits are reached', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('pagination'), diagnostics);

    const result = await client.listThreads({ pageSize: 1, maxPages: 1, maxRecords: 1 });

    expect(result.records).toHaveLength(1);
    expect(result.pagesRead).toBe(1);
    expect(result.nextCursor).toBe('page-2');
    expect(diagnostics).toEqual([]);
    await client.stop();
  });

  it('detects repeated cursors without retrying or looping', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('repeated-cursor'), diagnostics);

    await expect(client.listThreads({ maxPages: 3 })).rejects.toMatchObject({
      code: 'cursor-repeated',
    });
    expect(diagnostics).toContain('cursor-repeated');
    await client.stop();
  });

  it('bounds malformed and oversized protocol lines and suppresses server content', async () => {
    const malformedInitializeDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const malformedInitialize = createClient(
      await createFakeBinary('malformed-initialize'),
      malformedInitializeDiagnostics,
      1_000,
    );
    await expect(malformedInitialize.start()).rejects.toMatchObject({ code: 'protocol-malformed' });
    expect(malformedInitializeDiagnostics).toContain('protocol-malformed');
    await malformedInitialize.stop();

    const malformedDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const malformed = createClient(
      await createFakeBinary('malformed-result'),
      malformedDiagnostics,
      1_000,
    );
    await expect(malformed.listThreads()).rejects.toMatchObject({ code: 'protocol-malformed' });
    expect(malformedDiagnostics).toContain('protocol-malformed');
    await malformed.stop();

    const oversizedDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const oversized = createClient(
      await createFakeBinary('oversized'),
      oversizedDiagnostics,
      1_000,
    );
    await expect(oversized.listThreads()).rejects.toMatchObject({ code: 'request-timeout' });
    expect(oversizedDiagnostics).toContain('protocol-oversized');
    await oversized.stop();

    const stderrDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const stderr = createClient(await createFakeBinary('stderr'), stderrDiagnostics);
    await stderr.start();
    expect(stderrDiagnostics).toContain('server-stderr');
    expect(stderrDiagnostics).not.toContain('PRIVATE_SERVER_ERROR');
    await stderr.stop();

    const errorDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const serverError = createClient(
      await createFakeBinary('protocol-error'),
      errorDiagnostics,
      1_000,
    );
    await expect(serverError.listThreads()).rejects.toMatchObject({ code: 'protocol-error' });
    expect(errorDiagnostics).toContain('protocol-error');
    expect(errorDiagnostics).not.toContain('PRIVATE_SERVER_ERROR');
    await serverError.stop();
  });

  it('reports ambiguous source metadata without guessing a surface', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('unsupported-record'), diagnostics);

    const result = await client.listThreads({ maxPages: 1 });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.sourceEvidence.source).toBe('subAgentReview');
    expect(diagnostics).toEqual(['unsupported-record']);
    await client.stop();
  });

  it('times out bounded requests and rejects malformed JSON without exposing payloads', async () => {
    const delayDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const delayed = createClient(await createFakeBinary('delay'), delayDiagnostics, 30);
    await expect(delayed.listThreads()).rejects.toMatchObject({ code: 'request-timeout' });
    expect(delayDiagnostics).toContain('request-timeout');
    await delayed.stop();

    const malformedDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const malformed = createClient(
      await createFakeBinary('malformed-json'),
      malformedDiagnostics,
      500,
    );
    await expect(malformed.listThreads()).rejects.toMatchObject({ code: 'request-timeout' });
    expect(malformedDiagnostics).toContain('protocol-malformed');
    await malformed.stop();
  });

  it('caps concurrent pending requests with a fixed diagnostic', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('delay'), diagnostics, 40);
    const requests = await Promise.allSettled(
      Array.from({ length: 33 }, () => client.listThreads({ maxPages: 1 })),
    );

    expect(
      requests.some(
        (result) => result.status === 'rejected' && result.reason.code === 'request-capacity',
      ),
    ).toBe(true);
    expect(diagnostics).toContain('request-capacity');
    await client.stop();
  });

  it('stops an in-flight handshake and can restart after an owned child exits', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('slow-start'), diagnostics, 1_000);
    const start = client.start();
    await client.stop();
    await expect(start).rejects.toMatchObject({ code: 'stopped' });
    expect(client.connected).toBe(false);

    const exitDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const exiting = createClient(await createFakeBinary('exit'), exitDiagnostics, 1_000);
    await exiting.start();
    await expect(exiting.listThreads()).rejects.toMatchObject({ code: 'disconnected' });
    expect(exitDiagnostics).toContain('disconnected');
    await exiting.start();
    expect(exiting.connected).toBe(true);
    await exiting.stop();
  });

  it('rejects unsafe client options before spawning a process', () => {
    expect(() => new CodexCatalogClient({ binaryPath: 'codex' })).toThrowError(
      'Codex catalog invalid-options.',
    );
    expect(
      () => new CodexCatalogClient({ binaryPath: '/tmp/codex', codexHome: 'relative' }),
    ).toThrowError('Codex catalog invalid-options.');
  });
});

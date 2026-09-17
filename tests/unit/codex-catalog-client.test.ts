import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CodexCatalogClient,
  type CodexCatalogDiagnosticCode,
  type CodexCatalogTargetSurface,
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
  name: 'Codex task name',
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
if (mode === 'require-default-home' && process.env.CODEX_HOME !== undefined) process.exit(6);
let carry = '';
let initializeResponseSent = false;
let invalidUtf8Sent = false;
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
const expectedSourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
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
        setTimeout(() => {
          initializeResponseSent = true;
          process.stdout.write(JSON.stringify({ id: request.id, result: {
            codexHome: '/tmp/fake-codex-home', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake'
          }}) + '\\n');
        }, 200);
      } else {
        initializeResponseSent = true;
        process.stdout.write(JSON.stringify({ id: request.id, result: {
          codexHome: '/tmp/fake-codex-home', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake'
        }}) + '\\n');
      }
      continue;
    }
    if (request.method !== 'thread/list') continue;
    // Archived threads are never a product surface: any archived-route request
    // is a client regression and fails the fixture closed.
    if (request.params.archived !== false) process.exit(7);
    if (mode === 'require-discovery-page-size' && request.params.limit !== 25) process.exit(8);
    if (mode === 'slow-start' && !initializeResponseSent) process.exit(3);
    if (mode === 'require-source-kinds' && JSON.stringify(request.params.sourceKinds) !== JSON.stringify(expectedSourceKinds)) process.exit(4);
    if (mode === 'require-default-page-size' && request.params.limit !== 20) process.exit(5);
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
    }
    if (mode === 'invalid-utf8' && !invalidUtf8Sent) {
      invalidUtf8Sent = true;
      const prefix = Buffer.from('{"id":' + request.id + ',"result":"');
      const suffix = Buffer.from([0x22, 0x7d, 0x0a]);
      process.stdout.write(Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]));
      continue;
    }
    if (mode === 'exit') { process.exit(0); }
    const page = request.params.cursor === null ? pages[0] : pages[1];
    const outputPage = { ...page, data: page.data.slice(0, request.params.limit) };
    if (mode === 'unsupported-record') outputPage.data[0] = { ...outputPage.data[0], source: 'ambiguous' };
    if (mode === 'ambiguous-unknown') outputPage.data[0] = { ...outputPage.data[0], source: 'unknown', originator: null, cwd: null };
    if (mode === 'ambiguous-cli') outputPage.data[0] = { ...outputPage.data[0], source: 'cli', id: null };
    if (mode === 'ambiguous-desktop') outputPage.data[0] = { ...outputPage.data[0], source: 'vscode', originator: 'Codex Desktop', id: null };
    if (mode === 'ambiguous-subagent') outputPage.data[0] = { ...outputPage.data[0], source: { subAgent: 'review' }, id: null };
    if (mode === 'custom-source') {
      outputPage.data[0] = { ...outputPage.data[0], source: { custom: 'custom-connector' } };
    }
    if (mode === 'thread-source-subagent') {
      outputPage.data[0] = { ...outputPage.data[0], threadSource: 'subAgent' };
    }
    if (mode === 'conflicting-source') {
      outputPage.data[0] = {
        ...outputPage.data[0],
        source: { custom: 'custom-connector', subAgent: 'review' },
      };
    }
    if (mode === 'omitted-discarded') {
      const { preview, turns, status, modelProvider, projectId, ...metadata } = outputPage.data[0];
      outputPage.data[0] = metadata;
    }
    if (mode === 'changed-discarded') {
      const { ...metadata } = outputPage.data[0];
      outputPage.data[0] = {
        ...metadata,
        preview: 'PRIVATE_CHANGED_PREVIEW',
        turns: ['PRIVATE_CHANGED_TURNS'],
        status: 'PRIVATE_CHANGED_STATUS',
        modelProvider: 'PRIVATE_CHANGED_PROVIDER',
        projectId: 'PRIVATE_CHANGED_PROJECT',
      };
    }
    if (mode === 'empty-name') outputPage.data[0] = { ...outputPage.data[0], name: '   ' };
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
  targetSurface: CodexCatalogTargetSurface = 'desktop',
): CodexCatalogClient {
  return new CodexCatalogClient({
    binaryPath,
    codexHome: join(tmpdir(), 'codex-home-fixture'),
    requestTimeoutMs: timeoutMs,
    targetSurface,
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
  it('ignores an inherited custom home when no fixture home is requested', async () => {
    const binaryPath = await createFakeBinary('require-default-home');
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/private/unrelated-home';
    const client = new CodexCatalogClient({ binaryPath });
    try {
      const result = await client.listThreads({ maxPages: 1 });
      expect(result.records).toHaveLength(2);
    } finally {
      await client.stop();
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

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
      sourceEvidence: { source: 'subAgentReview', isSubAgent: true },
    });
    expect(result.records[2]).toMatchObject({
      nativeId: appServerThread.id,
      sourceEvidence: { source: 'appServer' },
    });
    expect(result.records[3]).toMatchObject({ nativeId: ephemeralThread.id, isEphemeral: true });
    expect(result.records[0]).not.toHaveProperty('preview');
    expect(result.records[0]).toHaveProperty('name', 'Codex task name');
    expect(result.records[0]).not.toHaveProperty('turns');
    expect(result.records[0]).not.toHaveProperty('projectId');
    expect(result.records[0]).not.toHaveProperty('isTopLevel');
    expect(JSON.stringify(result.records)).not.toContain('PRIVATE_');
    expect(diagnostics).toEqual([]);

    await client.stop();
    expect(client.isConnected).toBe(false);
  });

  it('requests every current bounded source kind for catalog discovery', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('require-source-kinds'), diagnostics);

    const result = await client.listThreads({ maxPages: 1 });

    expect(result.records).toHaveLength(2);
    expect(diagnostics).toEqual([]);
    await client.stop();
  });

  it('uses a conservative default page size for current protocol responses', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('require-default-page-size'), diagnostics);

    const result = await client.listThreads({ maxPages: 1 });

    expect(result.records).toHaveLength(2);
    expect(diagnostics).toEqual([]);
    await client.stop();
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

  it('requests the caller page size on the live route and never an archived route', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('require-discovery-page-size'), diagnostics);

    const result = await client.listThreads({ pageSize: 25, maxPages: 1 });

    expect(result.pagesRead).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe('page-cap');
    expect(result.nextCursor).toBe('page-2');
    expect(result.records).toHaveLength(2);
    expect(result.records.every((record) => record.isArchived === false)).toBe(true);
    expect(diagnostics).toEqual([]);
    await client.stop();
  });

  it('rejects a page size above the protocol bound before spawning a child', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(
      join(tmpdir(), 'agent-status-tiles-invalid-page-size-codex-executable'),
      diagnostics,
    );

    await expect(client.listThreads({ pageSize: 101 })).rejects.toMatchObject({
      code: 'invalid-options',
    });
    await expect(client.listThreads({ pageSize: 0 })).rejects.toMatchObject({
      code: 'invalid-options',
    });
    expect(diagnostics).toEqual(['invalid-options', 'invalid-options']);
    expect(client.isConnected).toBe(false);
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
    await expect.poll(() => stderrDiagnostics).toContain('server-stderr');
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

  it('skips malformed records with definitive CLI originator evidence', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('unsupported-record'), diagnostics);
    try {
      const result = await client.listThreads({ maxPages: 1 });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.sourceEvidence.source).toBe('subAgentReview');
      expect(diagnostics).toEqual([]);
    } finally {
      await client.stop();
    }
  });

  it('keeps malformed plausible CLI records ambiguous only for the CLI target', async () => {
    const desktopDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const desktop = createClient(await createFakeBinary('ambiguous-cli'), desktopDiagnostics);
    try {
      const desktopResult = await desktop.listThreads({ maxPages: 1 });
      expect(desktopResult.records).toHaveLength(1);
      expect(desktopResult.records[0]?.sourceEvidence.source).toBe('subAgentReview');
      expect(desktopDiagnostics).toEqual([]);
    } finally {
      await desktop.stop();
    }

    const cliDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const cli = createClient(await createFakeBinary('ambiguous-cli'), cliDiagnostics, 2_000, 'cli');
    try {
      const result = await cli.listThreads({ maxPages: 1 });
      expect(result.records).toHaveLength(1);
      expect(result.coverageIncomplete).toBe(true);
      expect(cliDiagnostics).toEqual(['coverage-ambiguous']);
      expect(JSON.stringify(cliDiagnostics)).not.toContain('PRIVATE_');
    } finally {
      await cli.stop();
    }
  });

  it('retains confirmed records while flagging malformed plausible Desktop coverage', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('ambiguous-desktop'), diagnostics);
    try {
      const result = await client.listThreads({ maxPages: 2 });
      expect(result.complete).toBe(true);
      expect(result.records).toHaveLength(2);
      expect(result.coverageIncomplete).toBe(true);
      expect(diagnostics).toEqual(['coverage-ambiguous']);
    } finally {
      await client.stop();
    }
  });

  it('skips known Desktop and subagent records for the CLI target while completing pagination', async () => {
    for (const mode of ['ambiguous-desktop', 'ambiguous-subagent']) {
      const diagnostics: CodexCatalogDiagnosticCode[] = [];
      const client = createClient(await createFakeBinary(mode), diagnostics, 2_000, 'cli');
      try {
        const result = await client.listThreads({ maxPages: 2 });
        expect(result.complete).toBe(true);
        expect(result.nextCursor).toBeNull();
        expect(result.pagesRead).toBe(2);
        expect(result.records).toHaveLength(2);
        expect(diagnostics).toEqual([]);
      } finally {
        await client.stop();
      }
    }
  });

  it('reports malformed unknown-source records without retaining their metadata', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('ambiguous-unknown'), diagnostics);
    try {
      const result = await client.listThreads({ maxPages: 1 });
      expect(result.coverageIncomplete).toBe(true);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_');
      expect(diagnostics).toEqual(['coverage-ambiguous']);
    } finally {
      await client.stop();
    }
  });

  it('retains bounded custom-source evidence and confirmed subagent markers', async () => {
    const customDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const custom = createClient(await createFakeBinary('custom-source'), customDiagnostics);
    const customResult = await custom.listThreads({ maxPages: 1 });
    expect(customResult.records[0]?.sourceEvidence).toMatchObject({
      source: 'custom',
      customSource: 'custom-connector',
      isSubAgent: false,
    });
    expect(customResult.records[0]).not.toHaveProperty('isTopLevel');
    await custom.stop();

    const markerDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const marker = createClient(
      await createFakeBinary('thread-source-subagent'),
      markerDiagnostics,
    );
    const markerResult = await marker.listThreads({ maxPages: 1 });
    expect(markerResult.records[0]?.sourceEvidence).toMatchObject({
      source: 'cli',
      threadSource: 'subAgent',
      isSubAgent: true,
    });
    await marker.stop();
  });

  it('rejects conflicting custom and subagent source variants', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('conflicting-source'), diagnostics);

    const result = await client.listThreads({ maxPages: 1 });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.sourceEvidence.source).toBe('subAgentReview');
    expect(diagnostics).toEqual([]);
    await client.stop();
  });

  it('projects metadata when discarded fields are omitted or changed', async () => {
    for (const mode of ['omitted-discarded', 'changed-discarded']) {
      const diagnostics: CodexCatalogDiagnosticCode[] = [];
      const client = createClient(await createFakeBinary(mode), diagnostics);
      const result = await client.listThreads({ maxPages: 1 });

      expect(result.records).toHaveLength(2);
      expect(result.records[0]).not.toHaveProperty('projectId');
      expect(result.records[0]).not.toHaveProperty('isTopLevel');
      expect(JSON.stringify(result.records)).not.toContain('PRIVATE_');
      expect(diagnostics).toEqual([]);
      await client.stop();
    }
  });

  it('drops an invalid optional task name without falling back to prompt preview', async () => {
    const client = createClient(await createFakeBinary('empty-name'), []);
    const result = await client.listThreads({ maxPages: 1 });
    expect(result.records[0]?.projectBasename).toBe('demo-app');
    expect(result.records[0]).not.toHaveProperty('name');
    expect(result.records[0]).not.toHaveProperty('preview');
    await client.stop();
  });

  it('times out bounded requests without hanging', async () => {
    const delayDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const delayed = createClient(await createFakeBinary('delay'), delayDiagnostics, 30);
    await expect(delayed.listThreads()).rejects.toMatchObject({ code: 'request-timeout' });
    expect(delayDiagnostics).toContain('request-timeout');
    await delayed.stop();
  });

  it('reports malformed JSON and recovers with metadata-only results', async () => {
    const malformedDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const malformed = createClient(
      await createFakeBinary('malformed-json'),
      malformedDiagnostics,
      2_000,
    );
    const result = await malformed.listThreads({ maxPages: 1 });
    expect(result.records).toHaveLength(2);
    expect(malformedDiagnostics).toEqual(['protocol-malformed']);
    expect(JSON.stringify(result.records)).not.toContain('PRIVATE_');
    await malformed.stop();
  });

  it('caps concurrent pending requests with a fixed diagnostic', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('delay'), diagnostics, 300);
    await client.start();
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

  it('awaits the delayed handshake before concurrent list calls', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('slow-start'), diagnostics, 1_000);
    const firstStart = client.start();
    const secondStart = client.start();
    const first = client.listThreads({ maxPages: 1 });
    const second = client.listThreads({ maxPages: 1 });
    const [, , firstResult, secondResult] = await Promise.all([
      firstStart,
      secondStart,
      first,
      second,
    ]);

    expect(firstResult.records).toHaveLength(2);
    expect(secondResult.records).toHaveLength(2);
    expect(diagnostics).toEqual([]);
    await client.stop();
  });

  it('rejects a start queued before the latest stop and permits a later restart', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('slow-start'), diagnostics, 1_000);
    const firstStart = client.start();
    const firstStop = client.stop();
    const queuedStart = client.start();
    const latestStop = client.stop();

    await expect(firstStart).rejects.toMatchObject({ code: 'stopped' });
    await expect(Promise.all([firstStop, latestStop])).resolves.toEqual([undefined, undefined]);
    await expect(queuedStart).rejects.toMatchObject({ code: 'stopped' });
    expect(client.isConnected).toBe(false);
    expect(
      (client as unknown as { ownedChildren: Set<ChildProcessWithoutNullStreams> }).ownedChildren
        .size,
    ).toBe(0);

    const restart = client.start();
    const concurrentRestart = client.start();
    await Promise.all([restart, concurrentRestart]);
    expect(client.isConnected).toBe(true);
    await client.stop();
    expect(
      (client as unknown as { ownedChildren: Set<ChildProcessWithoutNullStreams> }).ownedChildren
        .size,
    ).toBe(0);
  });

  it('stops an in-flight handshake and can restart after an owned child exits', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('slow-start'), diagnostics, 1_000);
    const start = client.start();
    await client.stop();
    await expect(start).rejects.toMatchObject({ code: 'stopped' });
    expect(client.isConnected).toBe(false);

    const exitDiagnostics: CodexCatalogDiagnosticCode[] = [];
    const exiting = createClient(await createFakeBinary('exit'), exitDiagnostics, 1_000);
    await exiting.start();
    await expect(exiting.listThreads()).rejects.toMatchObject({ code: 'disconnected' });
    expect(exitDiagnostics).toContain('disconnected');
    await exiting.start();
    expect(exiting.isConnected).toBe(true);
    await exiting.stop();
  });

  it('terminates a still-live owned child after a stream error before restart', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('pagination'), diagnostics, 1_000);
    await client.start();
    const child = (client as unknown as { child?: ChildProcessWithoutNullStreams }).child;
    if (child === undefined) throw new Error('expected owned child');

    child.stdout.emit('error', new Error('PRIVATE_STREAM_ERROR'));
    child.stdout.emit('error', new Error('PRIVATE_REPEATED_STREAM_ERROR'));
    child.stderr.emit('error', new Error('PRIVATE_STDERR_ERROR'));
    child.stderr.emit('error', new Error('PRIVATE_REPEATED_STDERR_ERROR'));
    child.emit('error', new Error('PRIVATE_REPEATED_CHILD_ERROR'));
    child.emit('error', new Error('PRIVATE_SECOND_CHILD_ERROR'));
    await client.start();

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(client.isConnected).toBe(true);
    expect(diagnostics).toContain('disconnected');
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_');
    await client.stop();
  });

  it('waits for SIGKILL reaping when an owned child ignores SIGTERM', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('ignore-term'), diagnostics, 3_000);
    await client.start();
    const child = (client as unknown as { child?: ChildProcessWithoutNullStreams }).child;
    if (child === undefined) throw new Error('expected owned child');

    await client.stop();

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(client.isConnected).toBe(false);
    expect(diagnostics).not.toContain('termination-failed');
  });

  it('rejects an invalid cursor before spawning a child', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(
      join(tmpdir(), 'agent-status-tiles-invalid-cursor-codex-executable'),
      diagnostics,
    );

    await expect(client.listThreads({ cursor: '' })).rejects.toMatchObject({
      code: 'invalid-options',
    });
    expect(diagnostics).toEqual(['invalid-options']);
    expect(client.isConnected).toBe(false);
    expect(
      (client as unknown as { ownedChildren: Set<ChildProcessWithoutNullStreams> }).ownedChildren
        .size,
    ).toBe(0);
    await client.stop();
  });

  it('rejects invalid UTF-8 protocol lines and recovers on the next request', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(await createFakeBinary('invalid-utf8'), diagnostics, 1_000);

    await expect(client.listThreads({ maxPages: 1 })).rejects.toMatchObject({
      code: 'request-timeout',
    });
    expect(diagnostics).toContain('protocol-malformed');

    const recovered = await client.listThreads({ maxPages: 1 });
    expect(recovered.records).toHaveLength(2);
    await client.stop();
  });

  it('releases a child that never spawned for a missing executable', async () => {
    const diagnostics: CodexCatalogDiagnosticCode[] = [];
    const client = createClient(
      join(tmpdir(), 'agent-status-tiles-no-such-codex-executable'),
      diagnostics,
      500,
    );

    await expect(client.start()).rejects.toMatchObject({ code: 'spawn-failed' });
    expect(diagnostics).toContain('spawn-failed');
    expect(diagnostics).not.toContain('termination-failed');
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it('rejects unsafe client options before spawning a process', () => {
    expect(() => new CodexCatalogClient({ binaryPath: 'codex' })).toThrowError(
      'Codex catalog invalid-options.',
    );
    expect(
      () => new CodexCatalogClient({ binaryPath: '/tmp/codex', codexHome: 'relative' }),
    ).toThrowError('Codex catalog invalid-options.');
    expect(
      () =>
        new CodexCatalogClient({
          binaryPath: '/tmp/codex',
          targetSurface: 'mobile' as CodexCatalogTargetSurface,
        }),
    ).toThrowError('Codex catalog invalid-options.');
  });
});

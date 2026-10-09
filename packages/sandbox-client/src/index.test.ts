/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The sandbox worker client's own contract: every op is a bearer-authed
 * POST to SANDBOX_WORKER_URL, a missing config answers 'unconfigured'
 * rather than an open call, a non-2xx or malformed body maps to a typed
 * error instead of throwing, and clientFailure phrases each error tag the
 * same way for every caller.
 */

import {
  sandboxConfig,
  sbFetchUrl,
  sbListFiles,
  sbStatFile,
  sbReadFile,
  sbWriteFile,
  sbDeleteFile,
  sbWorkspaceGitShow,
  sbChartRender,
  sbChartStage,
  sandboxChartsEnabled,
  clientFailure,
  sbWorkspaceGet,
  sbWorkspaceExec,
  sbRunScript,
  sandboxScriptsEnabled,
  sandboxScriptsAllowNetwork,
  sandboxScriptsServed,
  sbScriptsStatus,
  resetScriptsStatusForTests,
  setRetryDelayForTests,
} from './index';

/** A ready workspace as the worker answers it, for the retry test. */
function readyWorkspaceWire() {
  return {
    id: 'ws-1',
    provider: 'atlassian-bitbucket',
    repoFullName: 'acme/billing',
    branch: 'main',
    status: 'ready',
    error: null,
    sizeBytes: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    worker: null,
  };
}

const TARGET = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const WIRE_FILE = {
  id: 'file-1',
  filename: 'report.pdf',
  contentType: 'application/pdf',
  sizeBytes: 5,
  source: 'fetch:example.test',
  batchId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
};

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    SANDBOX_WORKER_URL: 'http://sandbox.internal:8092',
    SANDBOX_WORKER_API_KEY: 'test-key',
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('sandboxConfig', () => {
  it('reads the URL/key pair, trimming a trailing slash off the URL', () => {
    process.env.SANDBOX_WORKER_URL = 'http://sandbox.internal:8092/';
    expect(sandboxConfig()).toEqual({ url: 'http://sandbox.internal:8092', key: 'test-key' });
  });

  it('is null when either half of the pair is missing', () => {
    delete process.env.SANDBOX_WORKER_API_KEY;
    expect(sandboxConfig()).toBeNull();
  });
});

describe('sbFetchUrl / sbListFiles / sbStatFile / sbDeleteFile (JSON ops)', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('answers unconfigured without any network call when the worker is not set up', async () => {
    delete process.env.SANDBOX_WORKER_URL;
    fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await sbListFiles(TARGET);

    expect(result).toEqual({ ok: false, err: { kind: 'unconfigured' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to /v1/fetch with the bearer key and the target merged into the body', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(WIRE_FILE), { status: 200 }));

    const result = await sbFetchUrl(TARGET, {
      url: 'https://example.test/a.pdf',
      filename: 'report.pdf',
    });

    expect(result).toEqual({ ok: true, val: WIRE_FILE });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sandbox.internal:8092/v1/fetch');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      ...TARGET,
      url: 'https://example.test/a.pdf',
      filename: 'report.pdf',
    });
  });

  it('threads an optional batchId through sbListFiles, and omits it when absent', async () => {
    const listResponse = () =>
      new Response(JSON.stringify({ files: [WIRE_FILE] }), { status: 200 });
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(listResponse());

    await sbListFiles(TARGET, 'batch-1');
    const [, withBatch] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(withBatch.body))).toMatchObject({ batchId: 'batch-1' });

    await sbListFiles(TARGET);
    const [, withoutBatch] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(withoutBatch.body))).not.toHaveProperty('batchId');
  });

  it('refuses a malformed file in a list response rather than dropping it silently', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ files: [{ id: 'file-1' }] }), { status: 200 })
      );

    const result = await sbListFiles(TARGET);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.err.kind).toBe('unreachable');
  });

  it('maps a non-2xx response body to a typed op error', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'not_found', message: 'gone' } }), {
        status: 404,
      })
    );

    const result = await sbStatFile(TARGET, 'file-1');

    expect(result).toEqual({
      ok: false,
      err: { kind: 'op', type: 'not_found', message: 'gone', status: 404 },
    });
  });

  it('maps a network failure to unreachable', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await sbDeleteFile(TARGET, 'file-1');

    if (result.ok) throw new Error('expected failure');
    expect(result.err).toEqual({ kind: 'unreachable', message: 'ECONNREFUSED' });
    // A delete is never repeated on its own: one call, one failure.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a workspace read through a worker restart — refused, draining, then back', async () => {
    const waited: number[] = [];
    setRetryDelayForTests(async (ms) => {
      waited.push(ms);
    });
    try {
      const refused = Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      });
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(refused)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { type: 'shutting_down', message: 'stopping' } }), {
            status: 503,
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ workspace: readyWorkspaceWire() }), { status: 200 })
        );
      const result = await sbWorkspaceGet(TARGET, 'ws-1');
      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(waited).toEqual([1_000, 2_000]);
    } finally {
      setRetryDelayForTests(null);
    }
  });

  it('gives up on a read after the retry budget, and never retries a command or a timeout', async () => {
    setRetryDelayForTests(async () => {});
    try {
      const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(reset);
      const read = await sbWorkspaceGet(TARGET, 'ws-1');
      expect(read.ok).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(4);

      fetchSpy.mockClear();
      const ran = await sbWorkspaceExec(TARGET, { id: 'ws-1', command: 'pnpm test' });
      expect(ran.ok).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockClear();
      const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
      fetchSpy.mockRejectedValue(timeout);
      const slow = await sbWorkspaceGet(TARGET, 'ws-1');
      expect(slow.ok).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      setRetryDelayForTests(null);
    }
  });

  it('stops waiting on a command when the caller’s signal fires, and says so', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
          );
        })
    );
    const controller = new AbortController();
    const pending = sbWorkspaceExec(
      TARGET,
      { id: 'ws-1', command: 'sleep 200' },
      { signal: controller.signal }
    );
    controller.abort();
    const ran = await pending;
    expect(ran).toEqual({
      ok: false,
      err: { kind: 'unreachable', message: 'The command was stopped.' },
    });
  });

  it('reads an interrupted command back as such', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          exitCode: null,
          signal: 'SIGTERM',
          stdout: 'begun',
          stderr: '',
          timedOut: false,
          interrupted: true,
          truncated: false,
          durationMs: 1200,
          timeoutMs: 120000,
          sizeBytes: 10,
          unreadableEnv: [],
        }),
        { status: 200 }
      )
    );
    const ran = await sbWorkspaceExec(TARGET, { id: 'ws-1', command: 'sleep 30' });
    if (!ran.ok) throw new Error('expected a result');
    expect(ran.val).toMatchObject({ interrupted: true, timedOut: false, exitCode: null });
  });

  it('requires deleted: true in the response, not just a 2xx', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ deleted: false }), { status: 200 }));

    const result = await sbDeleteFile(TARGET, 'file-1');

    expect(result.ok).toBe(false);
  });
});

describe('sbRunScript', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('is offered only where the worker is configured and the flag is set', () => {
    expect(sandboxScriptsEnabled()).toBe(false);
    process.env.SANDBOX_SCRIPTS_ENABLED = 'true';
    expect(sandboxScriptsEnabled()).toBe(true);
    delete process.env.SANDBOX_WORKER_API_KEY;
    expect(sandboxScriptsEnabled()).toBe(false);
  });

  it('reads the operator’s network opt-in from its own flag', () => {
    expect(sandboxScriptsAllowNetwork()).toBe(false);
    process.env.SANDBOX_SCRIPTS_ALLOW_NETWORK = 'true';
    expect(sandboxScriptsAllowNetwork()).toBe(true);
  });

  it('reads what the worker does with scripts from /health, and nothing from an unreadable answer', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, scripts: 'unavailable' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await sbScriptsStatus()).toBe('unavailable');
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://sandbox.internal:8092/health');
    expect(await sbScriptsStatus()).toBeNull();
    expect(await sbScriptsStatus()).toBeNull();
  });

  it('withholds the tool once the worker has said scripts are unavailable, and offers it until then', async () => {
    resetScriptsStatusForTests();
    process.env.SANDBOX_SCRIPTS_ENABLED = 'true';
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, scripts: 'unavailable' })));
    // The first call has no answer yet: the flag decides, and the probe is kicked off once.
    expect(sandboxScriptsServed()).toBe(true);
    expect(sandboxScriptsServed()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sandboxScriptsServed()).toBe(false);
    // Without the flag nothing is asked at all.
    delete process.env.SANDBOX_SCRIPTS_ENABLED;
    expect(sandboxScriptsServed()).toBe(false);
    resetScriptsStatusForTests();
  });

  it('keeps offering the tool where the worker isolates or shares the network, or cannot be asked', async () => {
    process.env.SANDBOX_SCRIPTS_ENABLED = 'true';
    for (const answer of [
      new Response(JSON.stringify({ ok: true, scripts: 'isolated' })),
      new Response(JSON.stringify({ ok: true, scripts: 'network_shared' })),
      new Response('not json', { status: 500 }),
    ]) {
      resetScriptsStatusForTests();
      fetchSpy?.mockRestore();
      fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(answer);
      sandboxScriptsServed();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sandboxScriptsServed()).toBe(true);
    }
    resetScriptsStatusForTests();
  });

  it('POSTs to /v1/scripts/run with the target merged in and reads the outcome back', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          exitCode: 0,
          signal: null,
          stdout: 'matched 2\n',
          stderr: '',
          timedOut: false,
          interrupted: false,
          truncated: false,
          durationMs: 900,
          timeoutMs: 60000,
          inputs: [{ id: 'file-1', filename: 'report.pdf', path: 'in/report.pdf', sizeBytes: 5 }],
          outputs: [{ ...WIRE_FILE, id: 'file-2', filename: 'matched.csv', source: 'script' }],
          skippedOutputs: [{ filename: '.cache', reason: 'not a name a staged file may carry' }],
          networkIsolated: true,
          uidIsolated: true,
        }),
        { status: 200 }
      )
    );
    const ran = await sbRunScript(TARGET, { code: 'print(1)', files: ['file-1'], timeoutMs: 5000 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://sandbox.internal:8092/v1/scripts/run');
    expect(JSON.parse(String(init?.body))).toEqual({
      ...TARGET,
      code: 'print(1)',
      files: ['file-1'],
      timeoutMs: 5000,
    });
    if (!ran.ok) throw new Error('expected a result');
    expect(ran.val.outputs).toEqual([
      { ...WIRE_FILE, id: 'file-2', filename: 'matched.csv', source: 'script' },
    ]);
    expect(ran.val.inputs).toEqual([
      { id: 'file-1', filename: 'report.pdf', path: 'in/report.pdf', sizeBytes: 5 },
    ]);
    expect(ran.val.skippedOutputs).toHaveLength(1);
    expect(ran.val.networkIsolated).toBe(true);
  });

  it('refuses a malformed output in the answer rather than dropping it silently', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ exitCode: 0, stdout: '', stderr: '', outputs: [{ id: 'x' }] }),
          { status: 200 }
        )
      );
    const ran = await sbRunScript(TARGET, { code: 'print(1)' });
    expect(ran.ok).toBe(false);
  });

  it('maps a worker refusal to a typed op error the surfaces can phrase', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { type: 'busy', message: 'wait' } }), { status: 429 })
      );
    const ran = await sbRunScript(TARGET, { code: 'print(1)' });
    expect(ran).toEqual({
      ok: false,
      err: { kind: 'op', type: 'busy', message: 'wait', status: 429 },
    });
    expect(
      clientFailure({ kind: 'op', type: 'busy', message: undefined, status: 429 }).status
    ).toBe(429);
    expect(
      clientFailure({ kind: 'op', type: 'scripts_unavailable', message: undefined, status: 503 })
        .message
    ).toContain('not enabled');
  });
});

describe('sbReadFile', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('reads the filename off a header and the bytes off the body', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'x-sandbox-filename': 'report.pdf', 'content-type': 'application/pdf' },
      })
    );

    const result = await sbReadFile(TARGET, 'file-1');

    if (!result.ok) throw new Error('expected success');
    expect(result.val.filename).toBe('report.pdf');
    expect(result.val.contentType).toBe('application/pdf');
    expect(Array.from(result.val.bytes)).toEqual([1, 2, 3]);
  });

  it('URL-decodes a percent-encoded filename header', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(), {
        status: 200,
        headers: { 'x-sandbox-filename': encodeURIComponent('a report.pdf') },
      })
    );

    const result = await sbReadFile(TARGET, 'file-1');

    if (!result.ok) throw new Error('expected success');
    expect(result.val.filename).toBe('a report.pdf');
  });
});

describe('sbWriteFile', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('answers unconfigured without any network call when the worker is not set up', async () => {
    delete process.env.SANDBOX_WORKER_API_KEY;
    fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await sbWriteFile(TARGET, { filename: 'x.md' }, new Uint8Array([1]));

    expect(result).toEqual({ ok: false, err: { kind: 'unconfigured' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('puts target + metadata on the query string and the raw bytes as the body', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(WIRE_FILE), { status: 200 }));

    const bytes = new Uint8Array([104, 105]); // "hi"
    const result = await sbWriteFile(
      TARGET,
      {
        filename: 'report.pdf',
        contentType: 'application/pdf',
        source: 'document-ocr-pipeline',
        batchId: 'batch-1',
      },
      bytes
    );

    expect(result).toEqual({ ok: true, val: WIRE_FILE });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/write?');
    const query = new URL(url).searchParams;
    expect(query.get('tenantId')).toBe(TARGET.tenantId);
    expect(query.get('subject')).toBe(TARGET.subject);
    expect(query.get('filename')).toBe('report.pdf');
    expect(query.get('contentType')).toBe('application/pdf');
    expect(query.get('source')).toBe('document-ocr-pipeline');
    expect(query.get('batchId')).toBe('batch-1');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream'
    );
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
  });

  it('maps a non-2xx response to a typed op error', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'quota_exceeded', message: 'full' } }), {
        status: 429,
      })
    );

    const result = await sbWriteFile(TARGET, { filename: 'x.md' }, new Uint8Array([1]));

    expect(result).toEqual({
      ok: false,
      err: { kind: 'op', type: 'quota_exceeded', message: 'full', status: 429 },
    });
  });
});

describe('clientFailure', () => {
  it('maps unconfigured and unreachable without an op type', () => {
    expect(clientFailure({ kind: 'unconfigured' }).status).toBe(503);
    expect(clientFailure({ kind: 'unreachable', message: 'x' }).status).toBe(502);
  });

  it.each([
    ['not_found', 404],
    ['blocked_url', 400],
    ['too_large', 413],
    ['quota_exceeded', 429],
    ['fetch_failed', 502],
    ['bad_filename', 400],
  ])('maps op type %s to status %d', (type, status) => {
    const result = clientFailure({ kind: 'op', type, message: undefined, status: 999 });
    expect(result.status).toBe(status);
  });

  it('falls back to the worker-reported status and message for an unrecognized type', () => {
    const result = clientFailure({ kind: 'op', type: 'weird', message: 'huh', status: 418 });
    expect(result).toEqual({ status: 418, message: 'huh' });
  });
});

describe('browser verbs', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  const PAGE = {
    url: 'https://example.com/',
    title: 'Example',
    snapshot: 'Page: Example',
    truncated: false,
  };

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('posts each verb to /v1/browser/<op> with the target and arguments', async () => {
    const {
      sbBrowserNavigate,
      sbBrowserSnapshot,
      sbBrowserClick,
      sbBrowserType,
      sbBrowserSelect,
      sbBrowserPress,
      sbBrowserBack,
      sbBrowserClose,
    } = await import('./index');
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(PAGE), { status: 200 }));

    expect(await sbBrowserNavigate(TARGET, { url: 'https://example.com/', maxChars: 500 })).toEqual(
      { ok: true, val: PAGE }
    );
    await sbBrowserSnapshot(TARGET);
    await sbBrowserClick(TARGET, { ref: 'e1' });
    await sbBrowserType(TARGET, { ref: 'e2', text: 'hi', submit: true });
    await sbBrowserSelect(TARGET, { ref: 'e3', values: ['Blue'] });
    await sbBrowserPress(TARGET, { key: 'Escape' });
    await sbBrowserBack(TARGET);

    const calls = fetchSpy.mock.calls.map(([url, init]) => [
      String(url),
      JSON.parse(String(init?.body)),
    ]);
    expect(calls).toEqual([
      [
        'http://sandbox.internal:8092/v1/browser/navigate',
        { ...TARGET, url: 'https://example.com/', maxChars: 500 },
      ],
      ['http://sandbox.internal:8092/v1/browser/snapshot', TARGET],
      ['http://sandbox.internal:8092/v1/browser/click', { ...TARGET, ref: 'e1' }],
      [
        'http://sandbox.internal:8092/v1/browser/type',
        { ...TARGET, ref: 'e2', text: 'hi', submit: true },
      ],
      [
        'http://sandbox.internal:8092/v1/browser/select',
        { ...TARGET, ref: 'e3', values: ['Blue'] },
      ],
      ['http://sandbox.internal:8092/v1/browser/press', { ...TARGET, key: 'Escape' }],
      ['http://sandbox.internal:8092/v1/browser/back', TARGET],
    ]);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer test-key',
    });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ closed: true }), { status: 200 }));
    expect(await sbBrowserClose(TARGET)).toEqual({ ok: true, val: { closed: true } });
  });

  it('parses a screenshot as a staged file plus where the page was', async () => {
    const { sbBrowserScreenshot } = await import('./index');
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ file: WIRE_FILE, url: 'https://example.com/', title: 'Example' }),
        { status: 200 }
      )
    );
    const result = await sbBrowserScreenshot(TARGET, { fullPage: true, filename: 'home.png' });
    expect(result).toEqual({
      ok: true,
      val: { file: WIRE_FILE, url: 'https://example.com/', title: 'Example' },
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      ...TARGET,
      fullPage: true,
      filename: 'home.png',
    });
  });

  it('reads status, and treats a page without a snapshot as malformed', async () => {
    const { sbBrowserStatus, sbBrowserSnapshot } = await import('./index');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ enabled: true, sessions: 3 }), { status: 200 })
    );
    expect(await sbBrowserStatus()).toEqual({ ok: true, val: { enabled: true, sessions: 3 } });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ url: 'https://x' }), { status: 200 })
    );
    const result = await sbBrowserSnapshot(TARGET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.kind).toBe('unreachable');
  });

  it('carries the worker error tag and message through clientFailure', async () => {
    const { sbBrowserClick } = await import('./index');
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { type: 'bad_ref', message: 'No element carries ref e9' } }),
        { status: 400 }
      )
    );
    const result = await sbBrowserClick(TARGET, { ref: 'e9' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(clientFailure(result.err)).toEqual({
        status: 400,
        message: 'No element carries ref e9',
      });
    }
    expect(
      clientFailure({ kind: 'op', type: 'no_session', message: undefined, status: 409 })
    ).toEqual({
      status: 409,
      message: 'No page is open — open one with sandbox_browser_navigate first.',
    });
    expect(
      clientFailure({ kind: 'op', type: 'browser_unavailable', message: undefined, status: 503 })
        .status
    ).toBe(503);
  });
});

describe('sbBrowserRun / sbBrowserScroll', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  const PAGE = {
    url: 'https://example.com/',
    title: 'Example',
    snapshot: 'Page: Example',
    truncated: false,
  };

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('posts the steps and parses a full or partial run', async () => {
    const { sbBrowserRun } = await import('./index');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ completed: 2, page: PAGE, failed: null }), { status: 200 })
    );
    const steps = [{ kind: 'type' as const, ref: 'e1', text: 'a' }, { kind: 'back' as const }];
    expect(await sbBrowserRun(TARGET, { steps, maxChars: 500 })).toEqual({
      ok: true,
      val: { completed: 2, page: PAGE, failed: null },
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('http://sandbox.internal:8092/v1/browser/run');
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      ...TARGET,
      steps,
      maxChars: 500,
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          completed: 1,
          page: null,
          failed: { index: 1, kind: 'click', type: 'bad_ref', message: 'stale' },
        }),
        { status: 200 }
      )
    );
    expect(await sbBrowserRun(TARGET, { steps })).toEqual({
      ok: true,
      val: {
        completed: 1,
        page: null,
        failed: { index: 1, kind: 'click', type: 'bad_ref', message: 'stale' },
      },
    });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ page: PAGE }), { status: 200 }));
    const malformed = await sbBrowserRun(TARGET, { steps });
    expect(malformed.ok).toBe(false);
  });

  it('posts scroll fields', async () => {
    const { sbBrowserScroll } = await import('./index');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(PAGE), { status: 200 }));
    expect(await sbBrowserScroll(TARGET, { direction: 'up', amount: 200 })).toEqual({
      ok: true,
      val: PAGE,
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'http://sandbox.internal:8092/v1/browser/scroll'
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      ...TARGET,
      direction: 'up',
      amount: 200,
    });
  });
});

describe('secrets', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  const SECRET = {
    id: 'secret-1',
    name: 'vendor-portal',
    fields: ['username', 'password'],
    hosts: ['portal.vendor.com'],
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    lastUsedAt: null,
    unlockedUntil: '2026-01-01T08:00:00.000Z',
  };

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('creates, lists, unlocks, locks and revokes through /v1/secrets/*', async () => {
    const { sbSecretCreate, sbSecretsList, sbSecretUnlock, sbSecretLock, sbSecretRevoke } =
      await import('./index');
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ secret: SECRET, passphrase: 'abcde-fghjk-mnpqr-stuvw-xyz23' }),
        { status: 200 }
      )
    );
    expect(
      await sbSecretCreate(TARGET, {
        name: 'vendor-portal',
        fields: { password: 'x' },
        hosts: ['portal.vendor.com'],
        unlockMs: 1000,
      })
    ).toEqual({
      ok: true,
      val: { secret: SECRET, passphrase: 'abcde-fghjk-mnpqr-stuvw-xyz23' },
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'http://sandbox.internal:8092/v1/secrets/create'
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      ...TARGET,
      name: 'vendor-portal',
      fields: { password: 'x' },
      hosts: ['portal.vendor.com'],
      unlockMs: 1000,
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ secrets: [SECRET] }), { status: 200 })
    );
    expect(await sbSecretsList(TARGET)).toEqual({ ok: true, val: [SECRET] });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ secret: SECRET }), { status: 200 })
    );
    expect(await sbSecretUnlock(TARGET, { id: 'secret-1', passphrase: 'p'.repeat(12) })).toEqual({
      ok: true,
      val: SECRET,
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ secret: { ...SECRET, unlockedUntil: null } }), { status: 200 })
    );
    const locked = await sbSecretLock(TARGET, 'secret-1');
    expect(locked.ok && locked.val.unlockedUntil).toBeNull();

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ revoked: true, id: 'secret-1', name: 'vendor-portal' }), {
        status: 200,
      })
    );
    expect(await sbSecretRevoke(TARGET, 'secret-1')).toEqual({
      ok: true,
      val: { id: 'secret-1', name: 'vendor-portal' },
    });
  });

  it('phrases the secret error tags', () => {
    expect(
      clientFailure({ kind: 'op', type: 'bad_passphrase', message: undefined, status: 403 })
    ).toEqual({
      status: 403,
      message: 'That passphrase does not open this secret.',
    });
    expect(
      clientFailure({ kind: 'op', type: 'secret_unavailable', message: 'locked', status: 403 })
    ).toEqual({
      status: 403,
      message: 'locked',
    });
    expect(
      clientFailure({ kind: 'op', type: 'secret_exists', message: undefined, status: 409 }).status
    ).toBe(409);
    expect(
      clientFailure({ kind: 'op', type: 'secret_limit', message: undefined, status: 429 }).status
    ).toBe(429);
  });

  it('posts a secret reference on a type call, never a value', async () => {
    const { sbBrowserType } = await import('./index');
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ url: 'https://x', title: '', snapshot: 'Page', truncated: false }),
        { status: 200 }
      )
    );
    await sbBrowserType(TARGET, {
      ref: 'e1',
      secret: { name: 'vendor-portal', field: 'password' },
      submit: true,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      ...TARGET,
      ref: 'e1',
      secret: { name: 'vendor-portal', field: 'password' },
      submit: true,
    });
  });
});

describe('sandboxBrowserEnabled', () => {
  it('needs both the worker config and the flag', async () => {
    const { sandboxBrowserEnabled } = await import('./index');
    expect(sandboxBrowserEnabled()).toBe(false);
    process.env.SANDBOX_BROWSER_ENABLED = 'true';
    expect(sandboxBrowserEnabled()).toBe(true);
    process.env.SANDBOX_BROWSER_ENABLED = 'no';
    expect(sandboxBrowserEnabled()).toBe(false);
    process.env.SANDBOX_BROWSER_ENABLED = '1';
    delete process.env.SANDBOX_WORKER_URL;
    expect(sandboxBrowserEnabled()).toBe(false);
  });
});

describe('sbWorkspaceGitShow', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('POSTs the hash to workspaces/git-show and reads the commit, its state and its files back', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          branch: 'feat/x',
          commit: {
            sha: 'a'.repeat(40),
            shortSha: 'aaaaaaa',
            subject: 'Fix the login timeout',
            body: 'The session cookie expired before the token refresh fired.',
            author: 'Ada',
            date: '2026-09-01T10:00:00+00:00',
            parents: ['b'.repeat(40)],
          },
          pushed: true,
          inHead: true,
          diff: 'diff --git a/x b/x\n',
          files: [{ path: 'x', added: 1, deleted: 2, status: 'modified' }],
          truncated: false,
        }),
        { status: 200 }
      )
    );

    const result = await sbWorkspaceGitShow(TARGET, { id: 'ws-1', commit: 'aaaaaaa', context: 5 });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://sandbox.internal:8092/v1/workspaces/git-show',
      expect.objectContaining({ method: 'POST' })
    );
    const request = fetchSpy.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      ...TARGET,
      id: 'ws-1',
      commit: 'aaaaaaa',
      context: 5,
    });
    expect(result).toEqual({
      ok: true,
      val: {
        branch: 'feat/x',
        commit: {
          sha: 'a'.repeat(40),
          shortSha: 'aaaaaaa',
          subject: 'Fix the login timeout',
          body: 'The session cookie expired before the token refresh fired.',
          author: 'Ada',
          date: '2026-09-01T10:00:00+00:00',
          parents: ['b'.repeat(40)],
        },
        pushed: true,
        inHead: true,
        diff: 'diff --git a/x b/x\n',
        files: [{ path: 'x', added: 1, deleted: 2, status: 'modified' }],
        truncated: false,
      },
    });
  });

  it('answers unreachable when the commit is missing from the answer', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ branch: 'main', files: [] }), { status: 200 })
      );
    const result = await sbWorkspaceGitShow(TARGET, { id: 'ws-1', commit: 'aaaaaaa' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.kind).toBe('unreachable');
  });
});

describe('language server calls', () => {
  const { sbLspLanguages, sbLspOpen, sbLspSend, sbLspClose, sbLspEvents } =
    jest.requireActual<typeof import('./index')>('./index');

  it('lists the servers a worker has, in shape', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ languages: ['typescript', 3, 'go'] }), { status: 200 })
    ) as unknown as typeof fetch;
    expect(await sbLspLanguages(TARGET)).toEqual({ ok: true, val: ['typescript', 'go'] });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sandbox.internal:8092/v1/workspaces/lsp/languages');
    expect(JSON.parse(init.body as string)).toEqual(TARGET);
  });

  it('opens a session and keeps the capabilities verbatim', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'sess-1',
            server: 'typescript',
            workspaceId: 'ws-1',
            rootUri: 'file:///w/ws-1',
            capabilities: { hoverProvider: true },
            serverInfo: { name: 'ts' },
            reused: true,
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;
    const opened = await sbLspOpen(TARGET, { id: 'ws-1', server: 'typescript', clientId: 'ed' });
    expect(opened).toEqual({
      ok: true,
      val: {
        id: 'sess-1',
        server: 'typescript',
        workspaceId: 'ws-1',
        rootUri: 'file:///w/ws-1',
        capabilities: { hoverProvider: true },
        serverInfo: { name: 'ts' },
        reused: true,
      },
    });
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })
    ) as unknown as typeof fetch;
    const malformedOpen = await sbLspOpen(TARGET, {
      id: 'ws-1',
      server: 'typescript',
      clientId: 'ed',
    });
    expect(malformedOpen.ok).toBe(false);
  });

  it('sends, closes, and maps a refusal to its tag', async () => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ sent: true }), { status: 202 })
    ) as unknown as typeof fetch;
    expect(
      await sbLspSend(TARGET, { session: 's', message: { jsonrpc: '2.0', method: 'x' } })
    ).toEqual({ ok: true, val: undefined });
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: { type: 'bad_message', message: 'outside' } }), {
          status: 400,
        })
    ) as unknown as typeof fetch;
    const refused = await sbLspSend(TARGET, { session: 's', message: {} });
    expect(refused).toEqual({
      ok: false,
      err: { kind: 'op', type: 'bad_message', message: 'outside', status: 400 },
    });
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ closed: true }), { status: 200 })
    ) as unknown as typeof fetch;
    expect(await sbLspClose(TARGET, { session: 's' })).toEqual({ ok: true, val: true });
  });

  it('hands the events stream over as it is, and is unconfigured without the worker', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
        controller.close();
      },
    });
    global.fetch = jest.fn(
      async () => new Response(body, { status: 200 })
    ) as unknown as typeof fetch;
    const events = await sbLspEvents(TARGET, { session: 's' }, new AbortController().signal);
    expect(events.ok).toBe(true);
    if (events.ok) expect(await new Response(events.val).text()).toBe('data: {}\n\n');
    delete process.env.SANDBOX_WORKER_URL;
    expect(await sbLspEvents(TARGET, { session: 's' }, new AbortController().signal)).toEqual({
      ok: false,
      err: { kind: 'unconfigured' },
    });
  });
});

describe('sandboxChartsEnabled', () => {
  it('needs the worker configured AND the flag set', () => {
    delete process.env.SANDBOX_CHARTS_ENABLED;
    expect(sandboxChartsEnabled()).toBe(false);
    process.env.SANDBOX_CHARTS_ENABLED = 'true';
    expect(sandboxChartsEnabled()).toBe(true);
    delete process.env.SANDBOX_WORKER_URL;
    expect(sandboxChartsEnabled()).toBe(false);
  });
});

describe('sbChartRender', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('posts the request to charts/render and reads the bytes, type and size back', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-chart-width': '132',
          'x-chart-height': '82',
          'x-chart-diagram': encodeURIComponent('flowchart-v2'),
        },
      })
    );
    const result = await sbChartRender(TARGET, { source: 'pie', format: 'png', scale: 2 });
    if (!result.ok) throw new Error('expected success');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://sandbox.internal:8092/v1/charts/render',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ...TARGET, source: 'pie', format: 'png', scale: 2 }),
      })
    );
    expect(Array.from(result.val.bytes)).toEqual([1, 2, 3]);
    expect(result.val).toMatchObject({
      mediaType: 'image/png',
      width: 132,
      height: 82,
      diagramType: 'flowchart-v2',
    });
  });

  it('maps a worker refusal to a typed op error with its message', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { type: 'invalid_diagram', message: 'Parse error on line 2' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      );
    const result = await sbChartRender(TARGET, { source: 'pie' });
    expect(result).toEqual({
      ok: false,
      err: { kind: 'op', type: 'invalid_diagram', message: 'Parse error on line 2', status: 400 },
    });
  });
});

describe('sbChartStage', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('posts to charts/stage and reads the file and its size back', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          file: { ...WIRE_FILE, filename: 'chart.png', contentType: 'image/png' },
          width: 132,
          height: 82,
          diagramType: 'pie',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const result = await sbChartStage(TARGET, { source: 'pie', filename: 'chart.png' });
    if (!result.ok) throw new Error('expected success');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://sandbox.internal:8092/v1/charts/stage',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result.val.file.filename).toBe('chart.png');
    expect(result.val).toMatchObject({ width: 132, height: 82, diagramType: 'pie' });
  });

  it('refuses a body without a file as malformed', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ width: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const result = await sbChartStage(TARGET, { source: 'pie' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.err.kind).toBe('unreachable');
  });
});

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
  clientFailure,
} from './index';

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

    const result = await sbFetchUrl(TARGET, { url: 'https://example.test/a.pdf', filename: 'report.pdf' });

    expect(result).toEqual({ ok: true, val: WIRE_FILE });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sandbox.internal:8092/v1/fetch');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ ...TARGET, url: 'https://example.test/a.pdf', filename: 'report.pdf' });
  });

  it('threads an optional batchId through sbListFiles, and omits it when absent', async () => {
    const listResponse = () => new Response(JSON.stringify({ files: [WIRE_FILE] }), { status: 200 });
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(listResponse()).mockResolvedValueOnce(listResponse());

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
      .mockResolvedValue(new Response(JSON.stringify({ files: [{ id: 'file-1' }] }), { status: 200 }));

    const result = await sbListFiles(TARGET);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.err.kind).toBe('unreachable');
  });

  it('maps a non-2xx response body to a typed op error', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'not_found', message: 'gone' } }), { status: 404 })
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
  });

  it('requires deleted: true in the response, not just a 2xx', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ deleted: false }), { status: 200 }));

    const result = await sbDeleteFile(TARGET, 'file-1');

    expect(result.ok).toBe(false);
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
      { filename: 'report.pdf', contentType: 'application/pdf', source: 'document-ocr-pipeline', batchId: 'batch-1' },
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
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
  });

  it('maps a non-2xx response to a typed op error', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'quota_exceeded', message: 'full' } }), { status: 429 })
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
  const PAGE = { url: 'https://example.com/', title: 'Example', snapshot: 'Page: Example', truncated: false };

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('posts each verb to /v1/browser/<op> with the target and arguments', async () => {
    const {
      sbBrowserNavigate, sbBrowserSnapshot, sbBrowserClick, sbBrowserType, sbBrowserSelect,
      sbBrowserPress, sbBrowserBack, sbBrowserClose,
    } = await import('./index');
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(PAGE), { status: 200 }));

    expect(await sbBrowserNavigate(TARGET, { url: 'https://example.com/', maxChars: 500 })).toEqual({ ok: true, val: PAGE });
    await sbBrowserSnapshot(TARGET);
    await sbBrowserClick(TARGET, { ref: 'e1' });
    await sbBrowserType(TARGET, { ref: 'e2', text: 'hi', submit: true });
    await sbBrowserSelect(TARGET, { ref: 'e3', values: ['Blue'] });
    await sbBrowserPress(TARGET, { key: 'Escape' });
    await sbBrowserBack(TARGET);

    const calls = fetchSpy.mock.calls.map(([url, init]) => [String(url), JSON.parse(String(init?.body))]);
    expect(calls).toEqual([
      ['http://sandbox.internal:8092/v1/browser/navigate', { ...TARGET, url: 'https://example.com/', maxChars: 500 }],
      ['http://sandbox.internal:8092/v1/browser/snapshot', TARGET],
      ['http://sandbox.internal:8092/v1/browser/click', { ...TARGET, ref: 'e1' }],
      ['http://sandbox.internal:8092/v1/browser/type', { ...TARGET, ref: 'e2', text: 'hi', submit: true }],
      ['http://sandbox.internal:8092/v1/browser/select', { ...TARGET, ref: 'e3', values: ['Blue'] }],
      ['http://sandbox.internal:8092/v1/browser/press', { ...TARGET, key: 'Escape' }],
      ['http://sandbox.internal:8092/v1/browser/back', TARGET],
    ]);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer test-key' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ closed: true }), { status: 200 }));
    expect(await sbBrowserClose(TARGET)).toEqual({ ok: true, val: { closed: true } });
  });

  it('parses a screenshot as a staged file plus where the page was', async () => {
    const { sbBrowserScreenshot } = await import('./index');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ file: WIRE_FILE, url: 'https://example.com/', title: 'Example' }), { status: 200 })
    );
    const result = await sbBrowserScreenshot(TARGET, { fullPage: true, filename: 'home.png' });
    expect(result).toEqual({ ok: true, val: { file: WIRE_FILE, url: 'https://example.com/', title: 'Example' } });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      ...TARGET,
      fullPage: true,
      filename: 'home.png',
    });
  });

  it('reads status, and treats a page without a snapshot as malformed', async () => {
    const { sbBrowserStatus, sbBrowserSnapshot } = await import('./index');
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, sessions: 3 }), { status: 200 }));
    expect(await sbBrowserStatus()).toEqual({ ok: true, val: { enabled: true, sessions: 3 } });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://x' }), { status: 200 }));
    const result = await sbBrowserSnapshot(TARGET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.kind).toBe('unreachable');
  });

  it('carries the worker error tag and message through clientFailure', async () => {
    const { sbBrowserClick } = await import('./index');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: 'bad_ref', message: 'No element carries ref e9' } }), { status: 400 })
    );
    const result = await sbBrowserClick(TARGET, { ref: 'e9' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(clientFailure(result.err)).toEqual({ status: 400, message: 'No element carries ref e9' });
    }
    expect(clientFailure({ kind: 'op', type: 'no_session', message: undefined, status: 409 })).toEqual({
      status: 409,
      message: 'No page is open — open one with sandbox_browser_navigate first.',
    });
    expect(clientFailure({ kind: 'op', type: 'browser_unavailable', message: undefined, status: 503 }).status).toBe(503);
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

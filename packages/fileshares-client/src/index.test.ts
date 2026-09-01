/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The fileshare worker client's own contract: every op is a bearer-authed
 * POST to FILESHARES_WORKER_URL, a missing config answers 'unconfigured'
 * rather than an open call, a non-2xx or malformed body maps to a typed
 * error instead of throwing, and clientFailure phrases each error tag the
 * same way for every caller.
 */

import {
  fsListFolder,
  fsStatEntry,
  fsReadFile,
  fsWriteFile,
  fsMakeFolder,
  fsRemoveEntry,
  fsPreviewRemove,
  fsMoveEntry,
  fsRenameEntry,
  fsTestConnection,
  clientFailure,
} from './index';

const TARGET = { tenantId: 'tenant-1', shareId: 'share-1', subject: 'auth0|alice' };
const SHARE = { id: 'share-1', name: 'Accounting' };

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    FILESHARES_WORKER_URL: 'http://fileshares.internal:8090',
    FILESHARES_WORKER_API_KEY: 'test-key',
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('JSON ops (list, stat, mkdir, remove, remove-preview, move, rename, test-connection)', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('answers unconfigured without any network call when the worker is not set up', async () => {
    delete process.env.FILESHARES_WORKER_URL;
    fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await fsListFolder(TARGET, '/');

    expect(result).toEqual({ ok: false, err: { kind: 'unconfigured' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to /v1/list with the bearer key and the target + path merged into the body', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          share: SHARE,
          path: '/',
          entries: [{ name: 'a.txt', path: '/a.txt', kind: 'file', size: 5, modifiedAt: null }],
        }),
        { status: 200 }
      )
    );

    const result = await fsListFolder(TARGET, '/');

    expect(result).toEqual({
      ok: true,
      val: {
        share: SHARE,
        path: '/',
        entries: [{ name: 'a.txt', path: '/a.txt', kind: 'file', size: 5, modifiedAt: null }],
      },
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://fileshares.internal:8090/v1/list');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(init.body))).toEqual({ ...TARGET, path: '/' });
  });

  it('refuses a listing with a malformed entry rather than dropping it silently', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ share: SHARE, path: '/', entries: [{ name: 'a.txt' }] }), { status: 200 })
    );

    const result = await fsListFolder(TARGET, '/');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.err.kind).toBe('unreachable');
  });

  it('parses fsStatEntry, including nullable metadata fields', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          share: SHARE,
          path: '/a.txt',
          kind: 'file',
          size: 5,
          modifiedAt: '2026-01-01T00:00:00.000Z',
          createdAt: null,
          owner: null,
          group: null,
        }),
        { status: 200 }
      )
    );

    const result = await fsStatEntry(TARGET, '/a.txt');

    if (!result.ok) throw new Error('expected success');
    expect(result.val).toEqual({
      share: SHARE,
      path: '/a.txt',
      kind: 'file',
      size: 5,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      createdAt: null,
      owner: null,
      group: null,
    });
  });

  it('parses fsMoveEntry / fsRenameEntry relocations, including "unchanged"', async () => {
    const relocationResponse = () =>
      new Response(JSON.stringify({ share: SHARE, path: '/b.txt', unchanged: false }), { status: 200 });
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(relocationResponse())
      .mockResolvedValueOnce(relocationResponse());

    const moved = await fsMoveEntry(TARGET, '/a.txt', '/archive');
    expect(moved).toEqual({ ok: true, val: { share: SHARE, path: '/b.txt', unchanged: false } });
    const [, moveInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(moveInit.body))).toEqual({ ...TARGET, path: '/a.txt', toFolder: '/archive' });

    const renamed = await fsRenameEntry(TARGET, '/a.txt', 'b.txt');
    expect(renamed.ok).toBe(true);
    const [, renameInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(renameInit.body))).toEqual({ ...TARGET, path: '/a.txt', newName: 'b.txt' });
  });

  it('parses fsMakeFolder / fsRemoveEntry / fsPreviewRemove', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ share: SHARE, path: '/new' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ share: SHARE, path: '/old' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ share: SHARE, path: '/old', kind: 'file', size: 5, modifiedAt: null }),
          { status: 200 }
        )
      );

    expect(await fsMakeFolder(TARGET, '/new')).toEqual({ ok: true, val: { share: SHARE, path: '/new' } });
    expect(await fsRemoveEntry(TARGET, '/old')).toEqual({ ok: true, val: { share: SHARE, path: '/old' } });
    expect(await fsPreviewRemove(TARGET, '/old')).toEqual({
      ok: true,
      val: { share: SHARE, path: '/old', kind: 'file', size: 5, modifiedAt: null },
    });
  });

  it('posts fsTestConnection to /v1/test-connection with the credentials payload, no share target', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ entries: 4 }), { status: 200 }));

    const payload = {
      tenantId: 'tenant-1',
      shareId: 'share-1',
      credentials: { protocol: 'sftp' as const, username: 'alice', password: 'secret' },
    };
    const result = await fsTestConnection(payload);

    expect(result).toEqual({ ok: true, val: { entries: 4 } });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://fileshares.internal:8090/v1/test-connection');
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it('maps a non-2xx response body to a typed op error', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'not_connected' } }), { status: 403 })
    );

    const result = await fsStatEntry(TARGET, '/a.txt');

    expect(result).toEqual({
      ok: false,
      err: { kind: 'op', type: 'not_connected', message: undefined, status: 403 },
    });
  });

  it('maps a network failure to unreachable', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await fsListFolder(TARGET, '/');

    if (result.ok) throw new Error('expected failure');
    expect(result.err).toEqual({ kind: 'unreachable', message: 'ECONNREFUSED' });
  });
});

describe('fsReadFile', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('reads the raw bytes off the body and threads an optional maxBytes into the request', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const result = await fsReadFile(TARGET, '/a.txt', 1024);

    if (!result.ok) throw new Error('expected success');
    expect(Array.from(result.val)).toEqual([1, 2, 3]);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ ...TARGET, path: '/a.txt', maxBytes: 1024 });
  });
});

describe('fsWriteFile', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('answers unconfigured without any network call when the worker is not set up', async () => {
    delete process.env.FILESHARES_WORKER_API_KEY;
    fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await fsWriteFile(TARGET, '/new.txt', new Uint8Array([1]));

    expect(result).toEqual({ ok: false, err: { kind: 'unconfigured' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('puts the target + path on the query string and the raw bytes as the body', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ path: '/new.txt' }), { status: 200 }));

    const bytes = new Uint8Array([104, 105]); // "hi"
    const result = await fsWriteFile(TARGET, '/new.txt', bytes);

    expect(result).toEqual({ ok: true, val: { path: '/new.txt' } });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/write?');
    const query = new URL(url).searchParams;
    expect(query.get('tenantId')).toBe(TARGET.tenantId);
    expect(query.get('shareId')).toBe(TARGET.shareId);
    expect(query.get('subject')).toBe(TARGET.subject);
    expect(query.get('path')).toBe('/new.txt');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
  });

  it('falls back to the requested path when the response has no usable body', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));

    const result = await fsWriteFile(TARGET, '/new.txt', new Uint8Array([1]));

    expect(result).toEqual({ ok: true, val: { path: '/new.txt' } });
  });

  it('maps a non-2xx response to a typed op error', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'access_denied', message: 'no' } }), { status: 403 })
    );

    const result = await fsWriteFile(TARGET, '/new.txt', new Uint8Array([1]));

    expect(result).toEqual({
      ok: false,
      err: { kind: 'op', type: 'access_denied', message: 'no', status: 403 },
    });
  });
});

describe('clientFailure', () => {
  it('maps unconfigured and unreachable without an op type', () => {
    expect(clientFailure({ kind: 'unconfigured' }).status).toBe(503);
    expect(clientFailure({ kind: 'unreachable', message: 'x' }).status).toBe(502);
  });

  it.each([
    ['no_share', 404],
    ['not_connected', 403],
    ['bad_credentials', 503],
    ['access_denied', 403],
    ['store', 500],
  ])('maps op type %s to status %d', (type, status) => {
    const result = clientFailure({ kind: 'op', type, message: undefined, status: 999 });
    expect(result.status).toBe(status);
  });

  it('falls back to the worker-reported status and message for an unrecognized type', () => {
    const result = clientFailure({ kind: 'op', type: 'weird', message: 'huh', status: 418 });
    expect(result).toEqual({ status: 418, message: 'huh' });
  });
});

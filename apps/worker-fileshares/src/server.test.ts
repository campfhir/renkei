/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The HTTP seam's own contract: bearer auth fails closed, operations
 * dispatch to the service layer with the caller's exact parameters, errors
 * map onto statuses mechanically, and file bytes travel as raw bodies. The
 * service functions are mocked — their behavior is pinned in the package's
 * service.test.ts; here the subject is the wire.
 */

jest.mock('@renkei/connector-fileshares', () => {
  const actual = jest.requireActual<typeof import('@renkei/connector-fileshares')>(
    '@renkei/connector-fileshares'
  );
  return {
    ...actual,
    serviceListFolder: jest.fn(),
    serviceStatEntry: jest.fn(),
    serviceReadFile: jest.fn(),
    serviceWriteFile: jest.fn(),
    serviceMakeFolder: jest.fn(),
    serviceRemoveEntry: jest.fn(),
    servicePreviewRemove: jest.fn(),
    serviceMoveEntry: jest.fn(),
    serviceRenameEntry: jest.fn(),
    serviceAdminList: jest.fn(),
    serviceAdminSearch: jest.fn(),
    serviceTestConnection: jest.fn(),
  };
});

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFileshareServer } from './server';

const mocked = jest.requireMock<{
  serviceListFolder: jest.Mock;
  serviceStatEntry: jest.Mock;
  serviceReadFile: jest.Mock;
  serviceWriteFile: jest.Mock;
  serviceRemoveEntry: jest.Mock;
  serviceMoveEntry: jest.Mock;
  serviceAdminSearch: jest.Mock;
  serviceTestConnection: jest.Mock;
}>('@renkei/connector-fileshares');

const API_KEY = 'test-worker-key';
let server: Server;
let base: string;

beforeAll(async () => {
  server = createFileshareServer({
    db: {} as Kysely<DB>,
    encryptionKey: Buffer.alloc(32, 7),
    apiKeys: [API_KEY],
    maxTransferBytes: async () => 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => jest.clearAllMocks());

function post(path: string, body: unknown, key: string | null = API_KEY): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const TARGET = { tenantId: 'tenant-1', shareId: 'share-1', subject: 'auth0|alice' };

describe('authentication', () => {
  it('serves /health without a key', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
  });

  it('refuses a missing key and a wrong key alike', async () => {
    for (const key of [null, 'wrong-key']) {
      const response = await post('/v1/list', { ...TARGET, path: '/' }, key);
      expect(response.status).toBe(401);
    }
    expect(mocked.serviceListFolder).not.toHaveBeenCalled();
  });

  it('refuses everything when no keys are configured', async () => {
    const closed = createFileshareServer({
      db: {} as Kysely<DB>,
      encryptionKey: Buffer.alloc(32, 7),
      apiKeys: [],
    });
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/list`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => closed.close(() => resolve()));
    }
  });
});

describe('dispatch and serialization', () => {
  it('forwards list parameters and serializes entry dates', async () => {
    mocked.serviceListFolder.mockResolvedValue({
      ok: true,
      val: {
        share: { id: 'share-1', name: 'Accounting' },
        path: '/docs',
        access: 'read',
        entries: [
          {
            name: 'a.txt',
            path: '/docs/a.txt',
            kind: 'file',
            size: 5,
            modifiedAt: new Date('2026-01-02T03:04:05.000Z'),
            access: 'read',
          },
        ],
      },
    });
    const response = await post('/v1/list', { ...TARGET, path: '/docs' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      share: { id: 'share-1', name: 'Accounting' },
      path: '/docs',
      access: 'read',
      entries: [
        {
          name: 'a.txt',
          path: '/docs/a.txt',
          kind: 'file',
          size: 5,
          modifiedAt: '2026-01-02T03:04:05.000Z',
          access: 'read',
        },
      ],
    });
    expect(mocked.serviceListFolder).toHaveBeenCalledWith(
      expect.objectContaining({ encryptionKey: expect.any(Buffer) }),
      TARGET,
      '/docs'
    );
  });

  it('maps service error tags onto statuses and keeps the message', async () => {
    const cases: Array<[string, number]> = [
      ['no_share', 404],
      ['forbidden', 403],
      ['not_empty', 409],
      ['bad_path', 400],
      ['no_credentials', 503],
      ['timeout', 504],
    ];
    for (const [tag, status] of cases) {
      mocked.serviceStatEntry.mockResolvedValue({
        ok: false,
        val: undefined,
        err: { type: tag, message: `because ${tag}` },
      });
      const response = await post('/v1/stat', { ...TARGET, path: '/x' });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: { type: tag, message: `because ${tag}` },
      });
    }
  });

  it('rejects a body missing the subject before touching the service', async () => {
    const response = await post('/v1/stat', { tenantId: 't', shareId: 's', path: '/x' });
    expect(response.status).toBe(400);
    expect(mocked.serviceStatEntry).not.toHaveBeenCalled();
  });

  it('answers an unknown operation with 404 and malformed JSON with 400', async () => {
    const unknown = await post('/v1/nonsense', {});
    expect(unknown.status).toBe(404);
    const malformed = await fetch(`${base}/v1/list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: 'not json',
    });
    expect(malformed.status).toBe(400);
  });

  it('a crash inside a handler is a 500, not a hung socket', async () => {
    mocked.serviceStatEntry.mockRejectedValue(new Error('boom'));
    const response = await post('/v1/stat', { ...TARGET, path: '/x' });
    expect(response.status).toBe(500);
  });
});

describe('file bytes', () => {
  it('read answers the raw bytes as octet-stream, capped at the org limit', async () => {
    mocked.serviceReadFile.mockResolvedValue({
      ok: true,
      val: {
        share: { id: 'share-1', name: 'Accounting' },
        path: '/a.bin',
        bytes: new Uint8Array([1, 2, 3]),
      },
    });
    const response = await post('/v1/read', { ...TARGET, path: '/a.bin', maxBytes: 999_999 });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    // The requested cap never exceeds the org limit the deps supply (1024).
    expect(mocked.serviceReadFile.mock.calls[0][3]).toBe(1024);
  });

  it('write forwards the raw body with query-string addressing', async () => {
    mocked.serviceWriteFile.mockResolvedValue({
      ok: true,
      val: { share: { id: 'share-1', name: 'Accounting' }, path: '/up.bin' },
    });
    const query = new URLSearchParams({ ...TARGET, path: '/up.bin' });
    const response = await fetch(`${base}/v1/write?${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/octet-stream' },
      body: new Uint8Array([9, 8, 7]),
    });
    expect(response.status).toBe(200);
    const [, target, path, bytes, limit] = mocked.serviceWriteFile.mock.calls[0];
    expect(target).toEqual(TARGET);
    expect(path).toBe('/up.bin');
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([9, 8, 7]));
    expect(limit).toBe(1024);
  });

  it('a write body over the org limit is 413 without reaching the service', async () => {
    const query = new URLSearchParams({ ...TARGET, path: '/big.bin' });
    const response = await fetch(`${base}/v1/write?${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(2048),
    });
    expect(response.status).toBe(413);
    expect(mocked.serviceWriteFile).not.toHaveBeenCalled();
  });

  it('an empty write body is refused', async () => {
    const query = new URLSearchParams({ ...TARGET, path: '/empty.bin' });
    const response = await fetch(`${base}/v1/write?${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/octet-stream' },
    });
    expect(response.status).toBe(400);
    expect(mocked.serviceWriteFile).not.toHaveBeenCalled();
  });
});

describe('admin search', () => {
  it('dispatches the query and serializes hits with the truncation flag', async () => {
    mocked.serviceAdminSearch.mockResolvedValue({
      ok: true,
      val: {
        results: [{ name: 'Policies', path: '/it/Policies', kind: 'dir' }],
        truncated: true,
      },
    });
    const response = await post('/v1/admin-search', {
      tenantId: 'tenant-1',
      shareId: 'share-1',
      query: 'policies',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [{ name: 'Policies', path: '/it/Policies', kind: 'dir' }],
      truncated: true,
    });
    expect(mocked.serviceAdminSearch).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'share-1',
      'policies'
    );
  });
});

describe('test-connection payload validation', () => {
  const summary = {
    id: 'share-1',
    name: 'Accounting',
    protocol: 'sftp',
    host: 'nas.example.test',
    port: null,
    shareName: null,
    rootPath: '/srv/share',
    caseInsensitive: false,
    maxAccess: 'read_write',
  };

  it('accepts a valid summary with explicit credentials', async () => {
    mocked.serviceTestConnection.mockResolvedValue({ ok: true, val: { entries: 3 } });
    const response = await post('/v1/test-connection', {
      tenantId: 'tenant-1',
      storedShareId: null,
      summary,
      credentials: { protocol: 'sftp', username: 'svc', password: 'pw' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: 3 });
  });

  it('refuses a summary with a bad protocol or malformed credentials', async () => {
    const badSummary = await post('/v1/test-connection', {
      tenantId: 'tenant-1',
      summary: { ...summary, protocol: 'ftp' },
      credentials: null,
    });
    expect(badSummary.status).toBe(400);

    const badCredentials = await post('/v1/test-connection', {
      tenantId: 'tenant-1',
      summary,
      credentials: { protocol: 'sftp' },
    });
    expect(badCredentials.status).toBe(400);
    expect(mocked.serviceTestConnection).not.toHaveBeenCalled();
  });
});

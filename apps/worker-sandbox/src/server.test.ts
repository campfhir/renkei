/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The HTTP seam's own contract: bearer auth fails closed, quota/size limits
 * are enforced before any bytes move, and file bytes travel as raw bodies.
 * Disk and store are mocked — the wire is the subject here.
 */

jest.mock('./disk', () => ({
  newStorageKey: jest.fn(() => 'tenant-1/hashed-subject/file-1'),
  writeStream: jest.fn(),
  readFile: jest.fn(),
  deleteFile: jest.fn(),
  ensureDataRoot: jest.fn(),
}));

jest.mock('./store', () => ({
  insertFile: jest.fn(),
  listFiles: jest.fn(),
  totalStagedBytes: jest.fn(),
  countFiles: jest.fn(),
  totalStagedBytesForBatch: jest.fn(),
  countFilesForBatch: jest.fn(),
  getFile: jest.fn(),
  deleteFile: jest.fn(),
  listExpired: jest.fn(),
  deleteById: jest.fn(),
}));

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BlockedUrlError } from '@renkei/connector-sandbox';
import { createSandboxServer } from './server';

/** The outbound fetch `/v1/fetch` makes; each test that reaches it scripts one. */
let fetchUrl: (url: string, init: { signal: AbortSignal }) => Promise<Response> = async () => {
  throw new Error('no outbound fetch scripted for this test');
};

const disk = jest.requireMock<{
  newStorageKey: jest.Mock;
  writeStream: jest.Mock;
  readFile: jest.Mock;
  deleteFile: jest.Mock;
}>('./disk');

const store = jest.requireMock<{
  insertFile: jest.Mock;
  listFiles: jest.Mock;
  totalStagedBytes: jest.Mock;
  countFiles: jest.Mock;
  totalStagedBytesForBatch: jest.Mock;
  countFilesForBatch: jest.Mock;
  getFile: jest.Mock;
  deleteFile: jest.Mock;
}>('./store');

const API_KEY = 'test-worker-key';
let server: Server;
let base: string;

beforeAll(async () => {
  server = createSandboxServer({
    apiKeys: [API_KEY],
    maxFileBytes: async () => 1_048_576,
    fetchUrl: (url, init) => fetchUrl(url, init),
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

beforeEach(() => {
  jest.clearAllMocks();
  store.countFiles.mockResolvedValue(0);
  store.totalStagedBytes.mockResolvedValue(0);
  store.countFilesForBatch.mockResolvedValue(0);
  store.totalStagedBytesForBatch.mockResolvedValue(0);
});

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

const TARGET = { subject: 'auth0|alice' };

describe('authentication', () => {
  it('serves /health without a key', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
  });

  it('refuses a missing key and a wrong key alike', async () => {
    for (const key of [null, 'wrong-key']) {
      const response = await post('/v1/list', TARGET, key);
      expect(response.status).toBe(401);
    }
    expect(store.listFiles).not.toHaveBeenCalled();
  });

  it('refuses everything when no keys are configured', async () => {
    const closed = createSandboxServer({ apiKeys: [] });
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

describe('quota enforcement', () => {
  it('refuses a fetch when the file-count ceiling is already hit', async () => {
    store.countFiles.mockResolvedValue(200);
    const response = await post('/v1/fetch', {
      ...TARGET,
      url: 'https://example.com/report.pdf',
      filename: 'report.pdf',
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('quota_exceeded');
    expect(disk.writeStream).not.toHaveBeenCalled();
  });

  it('refuses a fetch when the byte quota is already full', async () => {
    store.totalStagedBytes.mockResolvedValue(200 * 1_048_576);
    const response = await post('/v1/fetch', {
      ...TARGET,
      url: 'https://example.com/report.pdf',
      filename: 'report.pdf',
    });
    expect(response.status).toBe(413);
    expect(disk.writeStream).not.toHaveBeenCalled();
  });
});

describe('batch quota pool', () => {
  const BATCH_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    // These two tests pass the quota check and reach the outbound fetch —
    // stand in a real Response so Readable.fromWeb has a genuine body
    // stream to bridge, without touching the network.
    fetchUrl = jest.fn(async () => new Response('bytes', { status: 200 }));
  });

  it('checks the batch pool, not the per-subject pool, when a batchId is given', async () => {
    store.countFiles.mockResolvedValue(1_000_000); // per-subject pool would refuse
    store.countFilesForBatch.mockResolvedValue(0);
    disk.writeStream.mockResolvedValue({ ok: true, sizeBytes: 4 });
    store.insertFile.mockResolvedValue({
      id: 'file-1',
      filename: 'page-1.tif',
      contentType: null,
      sizeBytes: 4,
      source: 'fetch:example.com',
      batchId: BATCH_ID,
      createdAt: new Date(),
      expiresAt: new Date(),
    });

    const response = await post('/v1/fetch', {
      ...TARGET,
      url: 'https://example.com/page-1.tif',
      filename: 'page-1.tif',
      batchId: BATCH_ID,
    });

    expect(response.status).toBe(200);
    expect(store.countFilesForBatch).toHaveBeenCalledWith(BATCH_ID);
    expect(store.countFiles).not.toHaveBeenCalled();
    const inserted = store.insertFile.mock.calls[0]?.[0] as { batchId: string | null };
    expect(inserted.batchId).toBe(BATCH_ID);
  });

  it('ignores a malformed batchId rather than passing it through as a pool key', async () => {
    disk.writeStream.mockResolvedValue({ ok: true, sizeBytes: 4 });
    store.insertFile.mockResolvedValue({
      id: 'file-1',
      filename: 'page-1.tif',
      contentType: null,
      sizeBytes: 4,
      source: 'fetch:example.com',
      batchId: null,
      createdAt: new Date(),
      expiresAt: new Date(),
    });

    const response = await post('/v1/fetch', {
      ...TARGET,
      url: 'https://example.com/page-1.tif',
      filename: 'page-1.tif',
      batchId: 'not-a-uuid',
    });

    expect(response.status).toBe(200);
    expect(store.countFilesForBatch).not.toHaveBeenCalled();
    expect(store.countFiles).toHaveBeenCalled();
  });
});

describe('sandbox_download_url egress guard', () => {
  it('refuses a private-range URL before any fetch happens', async () => {
    const response = await post('/v1/fetch', {
      ...TARGET,
      url: 'https://169.254.169.254/latest/meta-data',
      filename: 'x.txt',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('blocked_url');
    expect(disk.writeStream).not.toHaveBeenCalled();
  });

  it('refuses a non-https URL', async () => {
    const response = await post('/v1/fetch', {
      ...TARGET,
      url: 'http://example.com/report.pdf',
      filename: 'x.txt',
    });
    expect(response.status).toBe(400);
  });

  it('answers blocked_url when the guarded fetch refuses a redirect or a resolution', async () => {
    fetchUrl = jest.fn(async () => {
      throw new BlockedUrlError('host resolves to a private or reserved address');
    });
    const response = await post('/v1/fetch', {
      ...TARGET,
      url: 'https://example.com/redirects-to-metadata',
      filename: 'x.txt',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('blocked_url');
    expect(body.error.message).toMatch(/private or reserved/);
    expect(disk.writeStream).not.toHaveBeenCalled();
  });
});

describe('bad filenames', () => {
  it('refuses a filename with a path separator', async () => {
    const response = await post('/v1/fetch', {
      ...TARGET,
      url: 'https://example.com/report.pdf',
      filename: '../escape.pdf',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('bad_filename');
  });
});

describe('list/stat/delete dispatch', () => {
  it('serializes listed files', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const expiresAt = new Date('2026-01-02T00:00:00Z');
    store.listFiles.mockResolvedValue([
      {
        id: 'file-1',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
        source: 'fetch:example.com',
        createdAt,
        expiresAt,
      },
    ]);
    const response = await post('/v1/list', TARGET);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: unknown[] };
    expect(body.files).toEqual([
      {
        id: 'file-1',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
        source: 'fetch:example.com',
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    ]);
  });

  it('answers 404 for a missing file on stat/delete', async () => {
    store.getFile.mockResolvedValue(undefined);
    store.deleteFile.mockResolvedValue(undefined);
    const statResponse = await post('/v1/stat', { ...TARGET, fileId: 'missing' });
    expect(statResponse.status).toBe(404);
    const deleteResponse = await post('/v1/delete', { ...TARGET, fileId: 'missing' });
    expect(deleteResponse.status).toBe(404);
  });

  it('deletes both the row and the disk bytes', async () => {
    store.deleteFile.mockResolvedValue({
      id: 'file-1',
      filename: 'report.pdf',
      contentType: null,
      storageKey: 'tenant-1/hashed/file-1',
    });
    const response = await post('/v1/delete', { ...TARGET, fileId: 'file-1' });
    expect(response.status).toBe(200);
    expect(disk.deleteFile).toHaveBeenCalledWith('tenant-1/hashed/file-1');
  });
});

describe('draining', () => {
  it('turns every request away with 503 shutting_down once draining starts, health included', async () => {
    const draining = createSandboxServer({
      apiKeys: [API_KEY],
      maxFileBytes: async () => 1_048_576,
    });
    await new Promise<void>((resolve) => draining.listen(0, '127.0.0.1', resolve));
    const port = (draining.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    expect((await fetch(`${url}/health`)).status).toBe(200);
    draining.startDraining();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({
      error: {
        type: 'shutting_down',
        message: 'The sandbox worker is stopping; try again in a moment.',
      },
    });
    const listed = await fetch(`${url}/v1/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(TARGET),
    });
    expect(listed.status).toBe(503);
    expect(store.listFiles).not.toHaveBeenCalled();
    await draining.drain(1_000);
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });
});

describe('scratch-space scope', () => {
  const CHAT = 'chat:00000000-0000-4000-8000-0000000000c1';

  it('passes a chat’s scope through to the store', async () => {
    store.listFiles.mockResolvedValue([]);
    store.getFile.mockResolvedValue(undefined);
    expect((await post('/v1/list', { ...TARGET, scope: CHAT })).status).toBe(200);
    expect(store.listFiles).toHaveBeenCalledWith({ ...TARGET, scope: CHAT }, undefined);
    await post('/v1/stat', { ...TARGET, scope: CHAT, fileId: 'file-1' });
    expect(store.getFile).toHaveBeenCalledWith({ ...TARGET, scope: CHAT }, 'file-1');
  });

  it('stages a written file under the scope the query names', async () => {
    disk.writeStream.mockResolvedValue({ ok: true, sizeBytes: 3 });
    store.insertFile.mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'file-1',
      filename: input.filename,
      contentType: null,
      sizeBytes: 3,
      source: 'write',
      batchId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-02T00:00:00Z'),
    }));
    const query = new URLSearchParams({ ...TARGET, scope: CHAT, filename: 'a.txt' });
    const response = await fetch(`${base}/v1/write?${query.toString()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/octet-stream' },
      body: 'abc',
    });
    expect(response.status).toBe(200);
    expect(store.insertFile).toHaveBeenCalledWith(
      expect.objectContaining({ subject: TARGET.subject, scope: CHAT, filename: 'a.txt' })
    );
  });

  it('refuses a scope that is not a chat or a project', async () => {
    const response = await post('/v1/list', { ...TARGET, scope: 'chat:../../other' });
    expect(response.status).toBe(400);
    expect(store.listFiles).not.toHaveBeenCalled();
  });
});

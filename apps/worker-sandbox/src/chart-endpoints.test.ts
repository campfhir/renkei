/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The /v1/charts/* seam: `render` answers the bytes with the chart's media
 * type and size in headers, `stage` keeps them as a scratch-space file
 * under the caller's quota (named for the format, refused with a bad
 * name, refused when the quota is full before anything is drawn), a
 * disabled renderer answers 503, a malformed request 400 without a
 * render, and each ChartRenderError type maps to its status. The renderer
 * is a scripted double; disk and store are mocked as in server.test.ts.
 */

jest.mock('./disk', () => ({
  newStorageKey: jest.fn(() => 'tenant-1/hashed-subject/chart-1'),
  writeStream: jest.fn(),
  readFile: jest.fn(),
  deleteFile: jest.fn(),
  ensureDataRoot: jest.fn(),
}));

jest.mock('./secrets-store', () => ({
  insertSecret: jest.fn(),
  listSecrets: jest.fn(),
  countSecrets: jest.fn(),
  getSecret: jest.fn(),
  getSecretByName: jest.fn(),
  touchSecretUsed: jest.fn(),
  deleteSecret: jest.fn(),
  listExpiredSecrets: jest.fn(async () => []),
  deleteSecretById: jest.fn(),
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

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChartRenderError, type ChartVerbs } from './charts';
import { SecretVault } from './secret-vault';
import { createSandboxServer } from './server';

const disk = jest.requireMock<{ writeStream: jest.Mock }>('./disk');
const store = jest.requireMock<{
  insertFile: jest.Mock;
  totalStagedBytes: jest.Mock;
  countFiles: jest.Mock;
}>('./store');
const vault = new SecretVault({ sweepIntervalMs: 60 * 60_000 });

const API_KEY = 'test-worker-key';
const TARGET = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const RENDERED = {
  bytes: Buffer.from('png-bytes'),
  mediaType: 'image/png',
  width: 132,
  height: 82,
  diagramType: 'pie',
};

let charts: { render: jest.Mock };
let server: Server;
let base: string;

async function listen(deps: {
  charts: { render: jest.Mock } | null;
}): Promise<{ server: Server; base: string }> {
  const created = createSandboxServer({
    db: {} as Kysely<DB>,
    apiKeys: [API_KEY],
    maxFileBytes: async () => 1_048_576,
    browser: null,
    charts: deps.charts as unknown as ChartVerbs | null,
    vault,
  });
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  const address = created.address() as AddressInfo;
  return { server: created, base: `http://127.0.0.1:${address.port}` };
}

beforeAll(async () => {
  charts = { render: jest.fn(async () => RENDERED) };
  ({ server, base } = await listen({ charts }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vault.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  charts.render.mockResolvedValue(RENDERED);
  store.countFiles.mockResolvedValue(0);
  store.totalStagedBytes.mockResolvedValue(0);
});

function post(path: string, body: unknown, at = base): Promise<Response> {
  return fetch(`${at}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
}

describe('charts/render', () => {
  it('answers the bytes with the media type and the size in headers', async () => {
    const response = await post('/v1/charts/render', {
      ...TARGET,
      source: 'pie\n "a" : 1',
      format: 'png',
      theme: 'dark',
      background: 'transparent',
      scale: 3,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-chart-width')).toBe('132');
    expect(response.headers.get('x-chart-height')).toBe('82');
    expect(response.headers.get('x-chart-diagram')).toBe('pie');
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe('png-bytes');
    expect(charts.render).toHaveBeenCalledWith({
      source: 'pie\n "a" : 1',
      format: 'png',
      theme: 'dark',
      background: 'transparent',
      scale: 3,
    });
  });

  it('refuses a malformed request without rendering', async () => {
    const noSource = await post('/v1/charts/render', { ...TARGET, format: 'png' });
    expect(noSource.status).toBe(400);
    const badFormat = await post('/v1/charts/render', { ...TARGET, source: 'pie', format: 'gif' });
    expect(badFormat.status).toBe(400);
    const body = (await badFormat.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('bad_request');
    expect(body.error.message).toMatch(/format must be one of/);
    const noTarget = await post('/v1/charts/render', { source: 'pie' });
    expect(noTarget.status).toBe(400);
    expect(charts.render).not.toHaveBeenCalled();
  });

  it('maps each renderer error to its status, with the message', async () => {
    const cases: [ConstructorParameters<typeof ChartRenderError>[0], number][] = [
      ['invalid_diagram', 400],
      ['too_large', 413],
      ['render_failed', 500],
      ['charts_unavailable', 503],
      ['timeout', 504],
    ];
    for (const [type, status] of cases) {
      charts.render.mockRejectedValueOnce(new ChartRenderError(type, `because ${type}`));
      const response = await post('/v1/charts/render', { ...TARGET, source: 'pie' });
      expect(response.status).toBe(status);
      const body = (await response.json()) as { error: { type: string; message: string } };
      expect(body.error).toEqual({ type, message: `because ${type}` });
    }
  });

  it('answers 404 for a verb that is not one', async () => {
    const response = await post('/v1/charts/paint', { ...TARGET, source: 'pie' });
    expect(response.status).toBe(404);
  });
});

describe('charts/stage', () => {
  it('stages the bytes under the caller quota, typed and named for the format', async () => {
    disk.writeStream.mockResolvedValue({ ok: true, sizeBytes: 9 });
    const createdAt = new Date('2026-01-01T00:00:00Z');
    store.insertFile.mockImplementation(
      async (_db: unknown, input: { filename: string; contentType: string; source: string }) => ({
        id: 'chart-1',
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: 9,
        source: input.source,
        batchId: null,
        createdAt,
        expiresAt: createdAt,
      })
    );
    const response = await post('/v1/charts/stage', {
      ...TARGET,
      source: 'pie\n "a" : 1',
      filename: 'tickets.svg',
    });
    expect(response.status).toBe(200);
    const inserted = store.insertFile.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      ...TARGET,
      filename: 'tickets.png',
      contentType: 'image/png',
      source: 'chart:pie',
      batchId: null,
      storageKey: 'tenant-1/hashed-subject/chart-1',
    });
    const body = (await response.json()) as {
      file: { id: string; filename: string; contentType: string };
      width: number;
      height: number;
      diagramType: string;
    };
    expect(body.file).toMatchObject({
      id: 'chart-1',
      filename: 'tickets.png',
      contentType: 'image/png',
    });
    expect(body).toMatchObject({ width: 132, height: 82, diagramType: 'pie' });
  });

  it('names the file when the caller does not, and refuses a bad name before drawing', async () => {
    disk.writeStream.mockResolvedValue({ ok: true, sizeBytes: 9 });
    store.insertFile.mockImplementation(async (_db: unknown, input: { filename: string }) => ({
      id: 'chart-2',
      filename: input.filename,
      contentType: 'application/pdf',
      sizeBytes: 9,
      source: 'chart:pie',
      batchId: null,
      createdAt: new Date(),
      expiresAt: new Date(),
    }));
    const named = await post('/v1/charts/stage', { ...TARGET, source: 'pie', format: 'pdf' });
    expect(named.status).toBe(200);
    const body = (await named.json()) as { file: { filename: string } };
    expect(body.file.filename).toBe('chart.pdf');

    const bad = await post('/v1/charts/stage', {
      ...TARGET,
      source: 'pie',
      filename: '../escape',
    });
    expect(bad.status).toBe(400);
    expect(charts.render).toHaveBeenCalledTimes(1);
  });

  it('refuses when the caller quota is full, before drawing anything', async () => {
    store.countFiles.mockResolvedValue(200);
    const response = await post('/v1/charts/stage', { ...TARGET, source: 'pie' });
    expect(response.status).toBe(429);
    expect(charts.render).not.toHaveBeenCalled();
    expect(disk.writeStream).not.toHaveBeenCalled();
  });

  it('passes a renderer refusal through with its status', async () => {
    charts.render.mockRejectedValueOnce(new ChartRenderError('invalid_diagram', 'Parse error'));
    const response = await post('/v1/charts/stage', { ...TARGET, source: 'pie' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('invalid_diagram');
    expect(disk.writeStream).not.toHaveBeenCalled();
  });
});

describe('without a renderer', () => {
  let off: { server: Server; base: string };

  beforeAll(async () => {
    off = await listen({ charts: null });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => off.server.close(() => resolve()));
  });

  it('answers 503 for every chart verb', async () => {
    for (const op of ['render', 'stage']) {
      const response = await post(`/v1/charts/${op}`, { ...TARGET, source: 'pie' }, off.base);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { type: string } };
      expect(body.error.type).toBe('charts_unavailable');
    }
  });
});

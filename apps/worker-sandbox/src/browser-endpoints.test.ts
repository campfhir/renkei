/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The /v1/browser/* seam: dispatch to the verbs with the caller's own
 * target, a disabled browser answering 503 for every verb but status,
 * BrowserOpError types mapped to statuses, and a screenshot staged under
 * the same quota and cap as any other file. The browser itself is a
 * scripted double; disk and store are mocked as in server.test.ts.
 */

jest.mock('./disk', () => ({
  newStorageKey: jest.fn(() => 'tenant-1/hashed-subject/shot-1'),
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

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserOpError } from './browser';
import { createSandboxServer, type BrowserVerbs } from './server';

const disk = jest.requireMock<{ writeStream: jest.Mock }>('./disk');
const store = jest.requireMock<{
  insertFile: jest.Mock;
  totalStagedBytes: jest.Mock;
  countFiles: jest.Mock;
}>('./store');

const API_KEY = 'test-worker-key';
const TARGET = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const PAGE = {
  url: 'https://example.com/',
  title: 'Example',
  snapshot: 'Page: Example',
  truncated: false,
};

type Scripted = { [K in keyof BrowserVerbs]: jest.Mock };

function scriptedBrowser(): Scripted {
  return {
    sessionCount: jest.fn(() => 2),
    navigate: jest.fn(async () => PAGE),
    snapshot: jest.fn(async () => PAGE),
    click: jest.fn(async () => PAGE),
    type: jest.fn(async () => PAGE),
    select: jest.fn(async () => PAGE),
    press: jest.fn(async () => PAGE),
    back: jest.fn(async () => PAGE),
    screenshot: jest.fn(async () => ({
      bytes: Buffer.from('png'),
      url: 'https://example.com/x',
      title: 'Example',
    })),
    close: jest.fn(async () => true),
  };
}

let browser: Scripted;
let server: Server;
let base: string;

async function listen(deps: {
  browser: Scripted | null;
}): Promise<{ server: Server; base: string }> {
  const created = createSandboxServer({
    db: {} as Kysely<DB>,
    apiKeys: [API_KEY],
    maxFileBytes: async () => 1_048_576,
    browser: deps.browser as unknown as BrowserVerbs | null,
  });
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  const address = created.address() as AddressInfo;
  return { server: created, base: `http://127.0.0.1:${address.port}` };
}

beforeAll(async () => {
  browser = scriptedBrowser();
  ({ server, base } = await listen({ browser }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
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

describe('dispatch', () => {
  it('passes the caller target, arguments and a clamped maxChars to each verb', async () => {
    expect(
      (
        await post('/v1/browser/navigate', {
          ...TARGET,
          url: 'https://example.com/',
          maxChars: 500,
        })
      ).status
    ).toBe(200);
    expect(browser.navigate).toHaveBeenCalledWith(TARGET, 'https://example.com/', 500);

    await post('/v1/browser/snapshot', { ...TARGET, maxChars: 10_000_000 });
    expect(browser.snapshot).toHaveBeenCalledWith(TARGET, 80_000);

    await post('/v1/browser/snapshot', TARGET);
    expect(browser.snapshot).toHaveBeenLastCalledWith(TARGET, 20_000);

    await post('/v1/browser/click', { ...TARGET, ref: 'e3' });
    expect(browser.click).toHaveBeenCalledWith(TARGET, 'e3', 20_000);

    await post('/v1/browser/type', { ...TARGET, ref: 'e3', text: 'hi', submit: true });
    expect(browser.type).toHaveBeenCalledWith(TARGET, 'e3', 'hi', true, 20_000);

    await post('/v1/browser/type', { ...TARGET, ref: 'e3', text: 'hi', submit: 'yes' });
    expect(browser.type).toHaveBeenLastCalledWith(TARGET, 'e3', 'hi', false, 20_000);

    await post('/v1/browser/select', { ...TARGET, ref: 'e4', values: ['Blue'] });
    expect(browser.select).toHaveBeenCalledWith(TARGET, 'e4', ['Blue'], 20_000);

    await post('/v1/browser/press', { ...TARGET, key: 'Escape' });
    expect(browser.press).toHaveBeenCalledWith(TARGET, 'Escape', 20_000);

    await post('/v1/browser/back', TARGET);
    expect(browser.back).toHaveBeenCalledWith(TARGET, 20_000);

    const closed = await post('/v1/browser/close', TARGET);
    expect(await closed.json()).toEqual({ closed: true });
  });

  it('serializes the page state', async () => {
    const response = await post('/v1/browser/snapshot', TARGET);
    expect(await response.json()).toEqual(PAGE);
  });

  it('refuses a request without a caller target', async () => {
    const response = await post('/v1/browser/snapshot', { subject: 'auth0|alice' });
    expect(response.status).toBe(400);
    expect(browser.snapshot).not.toHaveBeenCalled();
  });

  it('answers status with session count', async () => {
    const response = await post('/v1/browser/status', {});
    expect(await response.json()).toEqual({ enabled: true, sessions: 2 });
  });

  it('answers 404 for an unknown browser verb', async () => {
    expect((await post('/v1/browser/evaluate', { ...TARGET, script: 'x' })).status).toBe(404);
  });

  it('maps every BrowserOpError type to its status and keeps the message', async () => {
    const cases: Array<[string, number]> = [
      ['browser_unavailable', 503],
      ['blocked_url', 400],
      ['no_session', 409],
      ['bad_ref', 400],
      ['bad_request', 400],
      ['navigation_failed', 502],
      ['action_failed', 400],
    ];
    for (const [type, status] of cases) {
      browser.snapshot.mockRejectedValueOnce(new BrowserOpError(type as never, `because ${type}`));
      const response = await post('/v1/browser/snapshot', TARGET);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { type, message: `because ${type}` } });
    }
  });
});

describe('screenshot staging', () => {
  it('stages the PNG under the caller quota and answers file + page', async () => {
    disk.writeStream.mockResolvedValue({ ok: true, sizeBytes: 3 });
    const createdAt = new Date('2026-01-01T00:00:00Z');
    store.insertFile.mockResolvedValue({
      id: 'shot-1',
      filename: 'home.png',
      contentType: 'image/png',
      sizeBytes: 3,
      source: 'browser:example.com',
      batchId: null,
      createdAt,
      expiresAt: createdAt,
    });
    const response = await post('/v1/browser/screenshot', {
      ...TARGET,
      filename: 'home.png',
      fullPage: true,
    });
    expect(response.status).toBe(200);
    expect(browser.screenshot).toHaveBeenCalledWith(TARGET, true);
    const inserted = store.insertFile.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      ...TARGET,
      filename: 'home.png',
      contentType: 'image/png',
      source: 'browser:example.com',
      batchId: null,
      storageKey: 'tenant-1/hashed-subject/shot-1',
    });
    const body = (await response.json()) as {
      file: { id: string; filename: string };
      url: string;
      title: string;
    };
    expect(body.file.id).toBe('shot-1');
    expect(body.url).toBe('https://example.com/x');
    expect(body.title).toBe('Example');
  });

  it('names the file when the caller does not, and refuses a bad name', async () => {
    disk.writeStream.mockResolvedValue({ ok: true, sizeBytes: 3 });
    store.insertFile.mockImplementation(async (_db: unknown, input: { filename: string }) => ({
      id: 'shot-2',
      filename: input.filename,
      contentType: 'image/png',
      sizeBytes: 3,
      source: 'browser:example.com',
      batchId: null,
      createdAt: new Date(),
      expiresAt: new Date(),
    }));
    const named = await post('/v1/browser/screenshot', TARGET);
    const body = (await named.json()) as { file: { filename: string } };
    expect(body.file.filename).toMatch(/^screenshot-\d+\.png$/);

    const bad = await post('/v1/browser/screenshot', { ...TARGET, filename: '../escape.png' });
    expect(bad.status).toBe(400);
    expect(browser.screenshot).toHaveBeenCalledTimes(1);
  });

  it('refuses when the caller quota is full, before taking the screenshot', async () => {
    store.countFiles.mockResolvedValue(200);
    const response = await post('/v1/browser/screenshot', TARGET);
    expect(response.status).toBe(429);
    expect(browser.screenshot).not.toHaveBeenCalled();
    expect(disk.writeStream).not.toHaveBeenCalled();
  });
});

describe('browser disabled', () => {
  let closedServer: Server;
  let closedBase: string;

  beforeAll(async () => {
    ({ server: closedServer, base: closedBase } = await listen({ browser: null }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));
  });

  it('answers 503 browser_unavailable for every verb, and status says disabled', async () => {
    const status = await post('/v1/browser/status', {}, closedBase);
    expect(await status.json()).toEqual({ enabled: false, sessions: 0 });
    for (const verb of ['navigate', 'snapshot', 'click', 'screenshot', 'close']) {
      const response = await post(
        `/v1/browser/${verb}`,
        { ...TARGET, url: 'https://example.com/' },
        closedBase
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { type: string } };
      expect(body.error.type).toBe('browser_unavailable');
    }
  });
});

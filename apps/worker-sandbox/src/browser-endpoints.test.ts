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
import { openSecretFields } from '@renkei/connector-sandbox';
import { BrowserOpError } from './browser';
import { SecretVault } from './secret-vault';
import { createSandboxServer, type BrowserVerbs } from './server';

const disk = jest.requireMock<{ writeStream: jest.Mock }>('./disk');
const store = jest.requireMock<{
  insertFile: jest.Mock;
  totalStagedBytes: jest.Mock;
  countFiles: jest.Mock;
}>('./store');
const secretsStore = jest.requireMock<{
  insertSecret: jest.Mock;
  listSecrets: jest.Mock;
  countSecrets: jest.Mock;
  getSecret: jest.Mock;
  getSecretByName: jest.Mock;
  deleteSecret: jest.Mock;
}>('./secrets-store');
const vault = new SecretVault({ sweepIntervalMs: 60 * 60_000 });

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
    scroll: jest.fn(async () => PAGE),
    back: jest.fn(async () => PAGE),
    run: jest.fn(async () => ({ completed: 2, page: PAGE, failed: null })),
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
    vault,
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
  vault.close();
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
    expect(browser.type).toHaveBeenCalledWith(TARGET, 'e3', 'hi', true, 20_000, undefined);

    await post('/v1/browser/type', { ...TARGET, ref: 'e3', text: 'hi', submit: 'yes' });
    expect(browser.type).toHaveBeenLastCalledWith(TARGET, 'e3', 'hi', false, 20_000, undefined);

    await post('/v1/browser/type', {
      ...TARGET,
      ref: 'e3',
      secret: { name: 'v', field: 'password' },
    });
    expect(browser.type).toHaveBeenLastCalledWith(TARGET, 'e3', undefined, false, 20_000, {
      name: 'v',
      field: 'password',
    });

    await post('/v1/browser/select', { ...TARGET, ref: 'e4', values: ['Blue'] });
    expect(browser.select).toHaveBeenCalledWith(TARGET, 'e4', ['Blue'], 20_000);

    await post('/v1/browser/press', { ...TARGET, key: 'Escape' });
    expect(browser.press).toHaveBeenCalledWith(TARGET, 'Escape', 20_000);

    await post('/v1/browser/scroll', { ...TARGET, direction: 'up', amount: 300 });
    expect(browser.scroll).toHaveBeenCalledWith(
      TARGET,
      { ref: undefined, direction: 'up', amount: 300 },
      20_000
    );

    await post('/v1/browser/back', TARGET);
    expect(browser.back).toHaveBeenCalledWith(TARGET, 20_000);

    const steps = [
      { kind: 'type', ref: 'e1', text: 'a' },
      { kind: 'click', ref: 'e2' },
    ];
    const ran = await post('/v1/browser/run', { ...TARGET, steps, maxChars: 900 });
    expect(browser.run).toHaveBeenCalledWith(TARGET, steps, 900);
    expect(await ran.json()).toEqual({ completed: 2, page: PAGE, failed: null });

    const closed = await post('/v1/browser/close', TARGET);
    expect(await closed.json()).toEqual({ closed: true });
  });

  it('serializes a partial run with its failure and no page', async () => {
    browser.run.mockResolvedValueOnce({
      completed: 1,
      page: null,
      failed: { index: 1, kind: 'click', type: 'bad_ref', message: 'stale' },
    });
    const response = await post('/v1/browser/run', { ...TARGET, steps: [{ kind: 'back' }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      completed: 1,
      page: null,
      failed: { index: 1, kind: 'click', type: 'bad_ref', message: 'stale' },
    });
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

describe('secrets', () => {
  const ROW = {
    id: 'secret-1',
    ...TARGET,
    name: 'vendor-portal',
    fields: ['username', 'password'],
    hosts: ['portal.vendor.com'],
    sealed: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-02-01T00:00:00Z'),
    lastUsedAt: null,
  };

  beforeEach(() => {
    secretsStore.countSecrets.mockResolvedValue(0);
    secretsStore.getSecretByName.mockResolvedValue(undefined);
    secretsStore.insertSecret.mockImplementation(
      async (_db: unknown, input: { sealed: string }) => ({
        ...ROW,
        sealed: input.sealed,
      })
    );
  });

  it('creates a secret sealed under a generated passphrase, returned once, and unlocks it', async () => {
    const response = await post('/v1/secrets/create', {
      ...TARGET,
      name: 'Vendor-Portal',
      fields: { username: 'alice', password: 'hunter2!' },
      hosts: 'https://portal.vendor.com/login',
      unlockMs: 60_000,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      secret: {
        id: string;
        name: string;
        fields: string[];
        hosts: string[];
        unlockedUntil: string | null;
      };
      passphrase: string | null;
    };
    expect(body.secret).toMatchObject({
      id: 'secret-1',
      name: 'vendor-portal',
      fields: ['username', 'password'],
      hosts: ['portal.vendor.com'],
    });
    expect(body.secret.unlockedUntil).not.toBeNull();
    expect(body.passphrase).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
    const inserted = secretsStore.insertSecret.mock.calls[0]?.[1] as {
      sealed: string;
      fields: string[];
    };
    expect(inserted.sealed).not.toContain('hunter2');
    expect(openSecretFields(inserted.sealed, body.passphrase!)).toEqual({
      username: 'alice',
      password: 'hunter2!',
    });
    expect(vault.open('secret-1', inserted.sealed)).toEqual({
      username: 'alice',
      password: 'hunter2!',
    });
    vault.lock('secret-1');
  });

  it('keeps a caller-chosen passphrase out of the response, and refuses a weak one', async () => {
    const chosen = await post('/v1/secrets/create', {
      ...TARGET,
      name: 'own',
      fields: { password: 'x' },
      hosts: ['a.example.com'],
      passphrase: 'my own long passphrase',
    });
    expect(chosen.status).toBe(200);
    expect(((await chosen.json()) as { passphrase: string | null }).passphrase).toBeNull();
    vault.lock('secret-1');

    const weak = await post('/v1/secrets/create', {
      ...TARGET,
      name: 'own',
      fields: { password: 'x' },
      hosts: ['a.example.com'],
      passphrase: 'short',
    });
    expect(weak.status).toBe(400);
    expect(secretsStore.insertSecret).toHaveBeenCalledTimes(1);
  });

  it('refuses a bad name, missing hosts, a duplicate name, and the per-caller limit', async () => {
    const good = { ...TARGET, fields: { password: 'x' }, hosts: ['a.example.com'] };
    expect((await post('/v1/secrets/create', { ...good, name: '-bad' })).status).toBe(400);
    expect((await post('/v1/secrets/create', { ...good, name: 'ok', hosts: [] })).status).toBe(400);
    secretsStore.getSecretByName.mockResolvedValueOnce(ROW);
    const dup = await post('/v1/secrets/create', { ...good, name: 'vendor-portal' });
    expect(dup.status).toBe(409);
    secretsStore.countSecrets.mockResolvedValueOnce(50);
    expect((await post('/v1/secrets/create', { ...good, name: 'fifty-first' })).status).toBe(429);
    expect(secretsStore.insertSecret).not.toHaveBeenCalled();
  });

  it('unlocks with the right passphrase only, locks, lists with lock state, and revokes', async () => {
    const { sealSecretFields } = await import('@renkei/connector-sandbox');
    const sealed = sealSecretFields({ password: 'x' }, 'correct horse battery');
    secretsStore.getSecret.mockResolvedValue({ ...ROW, sealed });
    secretsStore.listSecrets.mockResolvedValue([{ ...ROW, sealed }]);

    const wrong = await post('/v1/secrets/unlock', {
      ...TARGET,
      id: 'secret-1',
      passphrase: 'wrong horse battery',
    });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: { type: string } }).error.type).toBe('bad_passphrase');
    expect(vault.unlockedUntil('secret-1')).toBeNull();

    const right = await post('/v1/secrets/unlock', {
      ...TARGET,
      id: 'secret-1',
      passphrase: 'correct horse battery',
      unlockMs: 60_000,
    });
    expect(right.status).toBe(200);
    const listed = await post('/v1/secrets/list', TARGET);
    const body = (await listed.json()) as {
      secrets: { name: string; unlockedUntil: string | null }[];
    };
    expect(body.secrets[0].name).toBe('vendor-portal');
    expect(body.secrets[0].unlockedUntil).not.toBeNull();
    expect(JSON.stringify(body)).not.toContain('sealed');

    const locked = await post('/v1/secrets/lock', { ...TARGET, id: 'secret-1' });
    expect(
      ((await locked.json()) as { secret: { unlockedUntil: string | null } }).secret.unlockedUntil
    ).toBeNull();

    await post('/v1/secrets/unlock', {
      ...TARGET,
      id: 'secret-1',
      passphrase: 'correct horse battery',
    });
    secretsStore.deleteSecret.mockResolvedValueOnce({ id: 'secret-1', name: 'vendor-portal' });
    const revoked = await post('/v1/secrets/revoke', { ...TARGET, id: 'secret-1' });
    expect(await revoked.json()).toEqual({ revoked: true, id: 'secret-1', name: 'vendor-portal' });
    expect(vault.unlockedUntil('secret-1')).toBeNull();

    secretsStore.getSecret.mockResolvedValueOnce(undefined);
    expect(
      (
        await post('/v1/secrets/unlock', {
          ...TARGET,
          id: 'missing',
          passphrase: 'correct horse battery',
        })
      ).status
    ).toBe(404);
  });

  it('maps a secret refusal from the browser to 403', async () => {
    browser.type.mockRejectedValueOnce(new BrowserOpError('secret_unavailable', 'locked'));
    const response = await post('/v1/browser/type', {
      ...TARGET,
      ref: 'e1',
      secret: { name: 'v', field: 'p' },
    });
    expect(response.status).toBe(403);
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

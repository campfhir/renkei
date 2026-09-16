/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The HTTP seam's own contract: bearer auth fails closed, the api op
 * resolves the caller's OWN credential, logs in once and reuses the
 * session, retries exactly once on a lapsed session, envelopes the
 * upstream status verbatim, and never lets a request name a host. The
 * upstream dialer and the store are injected — the subject is the wire
 * and the session dance, not Mirth.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InstanceRow, ResolvedTarget } from '@renkei/connector-mirth';
import { createMirthServer } from './server';
import { resetSessions } from './sessions';
import type { UpstreamRequest, UpstreamResponse } from './upstream';

const API_KEY = 'test-worker-key';
const INSTANCE_ID = '11111111-2222-3333-4444-555555555555';
const TARGET = { tenantId: 'tenant-1', instanceId: INSTANCE_ID, subject: 'auth0|alice' };

const instance: InstanceRow = {
  summary: {
    id: INSTANCE_ID,
    name: 'Prod',
    environment: 'prod',
    baseUrl: 'https://mirth.example:8443',
    tlsVerify: false,
    hasCustomCa: false,
    allowInsecureHttp: false,
    enabled: true,
  },
  caPem: null,
  settings: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const resolved: ResolvedTarget = {
  instance,
  credentials: { username: 'alice', password: 'pw' },
};

let calls: UpstreamRequest[] = [];
let script: Array<
  UpstreamResponse | { failed: 'timeout' | 'unreachable' | 'too_large'; detail: string }
> = [];

const ok = (body: string, extra: Partial<UpstreamResponse> = {}): UpstreamResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(body),
  ...extra,
});
const loginOk = (): UpstreamResponse =>
  ok('{"status":"SUCCESS"}', { headers: { 'set-cookie': ['JSESSIONID=s1; Path=/api; HttpOnly'] } });

let server: Server;
let base: string;

beforeAll(async () => {
  server = createMirthServer({
    db: {} as Kysely<DB>,
    encryptionKey: Buffer.alloc(32, 7),
    apiKeys: [API_KEY],
    dial: async (input) => {
      calls.push(input);
      const next = script.shift();
      if (!next) throw new Error(`unscripted upstream call: ${input.method} ${input.url}`);
      return next;
    },
    resolveTarget: async (target) =>
      target.instanceId === INSTANCE_ID && target.subject === 'auth0|alice'
        ? { ok: true, val: resolved }
        : { ok: false, err: { type: 'not_connected' } as never },
    resolveInstance: async (_tenantId, instanceId) =>
      instanceId === INSTANCE_ID
        ? { ok: true, val: instance }
        : { ok: false, err: { type: 'no_instance' } as never },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  calls = [];
  script = [];
  resetSessions();
});

type Envelope = { status: number; body: string; error?: { type: string } };
const json = (response: Response): Promise<Envelope> => response.json() as Promise<Envelope>;

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

describe('authentication', () => {
  it('serves /health without a key', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
  });

  it('refuses a missing key and a wrong key alike', async () => {
    for (const key of [null, 'wrong-key']) {
      const response = await post('/v1/api', { ...TARGET, method: 'GET', path: '/channels' }, key);
      expect(response.status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('refuses everything when no keys are configured', async () => {
    const closed = createMirthServer({
      db: {} as Kysely<DB>,
      encryptionKey: Buffer.alloc(32, 7),
      apiKeys: [],
    });
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/api`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => closed.close(() => resolve()));
    }
  });

  it('answers 405 to non-POST and 404 to unknown ops', async () => {
    const get = await fetch(`${base}/v1/api`, { headers: { authorization: `Bearer ${API_KEY}` } });
    expect(get.status).toBe(405);
    const unknown = await post('/v1/nope', {});
    expect(unknown.status).toBe(404);
  });
});

describe('api', () => {
  it('logs in once, forwards with the session cookie, and envelopes the upstream answer', async () => {
    script = [loginOk(), ok('{"list":{"channel":[]}}')];
    const response = await post('/v1/api', {
      ...TARGET,
      method: 'GET',
      path: '/channels',
      query: { channelId: ['a', 'b'], pollingOnly: true },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 200,
      contentType: 'application/json',
      body: '{"list":{"channel":[]}}',
    });

    expect(calls).toHaveLength(2);
    const [login, call] = calls;
    expect(login.url).toBe('https://mirth.example:8443/api/users/_login');
    expect(login.method).toBe('POST');
    expect(login.body?.toString()).toBe('username=alice&password=pw');
    expect(login.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(login.tls).toEqual({ verify: false, caPem: null });

    expect(call.url).toBe(
      'https://mirth.example:8443/api/channels?channelId=a&channelId=b&pollingOnly=true'
    );
    expect(call.headers.cookie).toBe('JSESSIONID=s1');
    expect(call.headers.accept).toBe('application/json');
    expect(call.headers['x-requested-with']).toBe('OpenAPI');
  });

  it('reuses the session on the next call for the same person and instance', async () => {
    script = [loginOk(), ok('1'), ok('2')];
    await post('/v1/api', { ...TARGET, method: 'GET', path: '/server/id' });
    const second = await post('/v1/api', { ...TARGET, method: 'GET', path: '/server/id' });
    expect((await json(second)).body).toBe('2');
    expect(calls.map((call) => call.url)).toEqual([
      'https://mirth.example:8443/api/users/_login',
      'https://mirth.example:8443/api/server/id',
      'https://mirth.example:8443/api/server/id',
    ]);
    expect(calls[2].headers.cookie).toBe('JSESSIONID=s1');
  });

  it('re-logs in exactly once when the session lapsed, then forwards the second verdict', async () => {
    script = [
      loginOk(),
      { status: 401, headers: {}, body: Buffer.from('') },
      ok('{"status":"SUCCESS"}', { headers: { 'set-cookie': ['JSESSIONID=s2'] } }),
      { status: 401, headers: {}, body: Buffer.from('still no') },
    ];
    const response = await post('/v1/api', { ...TARGET, method: 'GET', path: '/channels' });
    expect((await json(response)).status).toBe(401);
    expect(calls.map((call) => call.url)).toEqual([
      'https://mirth.example:8443/api/users/_login',
      'https://mirth.example:8443/api/channels',
      'https://mirth.example:8443/api/users/_login',
      'https://mirth.example:8443/api/channels',
    ]);
    expect(calls[3].headers.cookie).toBe('JSESSIONID=s2');
  });

  it('sends a JSON body with the content type the caller names', async () => {
    script = [loginOk(), ok('', { status: 204 })];
    await post('/v1/api', {
      ...TARGET,
      method: 'PUT',
      path: '/server/configurationMap',
      body: { map: { entry: [] } },
    });
    const call = calls[1];
    expect(call.method).toBe('PUT');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body?.toString()).toBe('{"map":{"entry":[]}}');

    script = [ok('', { status: 204 })];
    await post('/v1/api', {
      ...TARGET,
      method: 'POST',
      path: '/channels/abc/messages',
      body: 'MSH|^~\\&|...',
      contentType: 'text/plain',
    });
    expect(calls[2].headers['content-type']).toBe('text/plain');
    expect(calls[2].body?.toString()).toBe('MSH|^~\\&|...');
  });

  it('reports a rejected stored credential as login_failed', async () => {
    script = [{ status: 401, headers: {}, body: Buffer.from('') }];
    const response = await post('/v1/api', { ...TARGET, method: 'GET', path: '/channels' });
    expect(response.status).toBe(403);
    expect((await json(response)).error?.type).toBe('login_failed');
  });

  it('refuses paths that climb, carry a query, or name another host — before any dial', async () => {
    for (const path of ['channels', '/channels/../users', '/x?y=1', '//evil.example/x', '/a b']) {
      const response = await post('/v1/api', { ...TARGET, method: 'GET', path });
      expect(response.status).toBe(400);
    }
    const method = await post('/v1/api', { ...TARGET, method: 'PATCH', path: '/channels' });
    expect(method.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('answers 403 for a person who has not connected the instance', async () => {
    const response = await post('/v1/api', {
      ...TARGET,
      subject: 'auth0|bob',
      method: 'GET',
      path: '/channels',
    });
    expect(response.status).toBe(403);
    expect((await json(response)).error?.type).toBe('not_connected');
    expect(calls).toEqual([]);
  });

  it('maps upstream failures onto their statuses', async () => {
    script = [loginOk(), { failed: 'timeout', detail: 'no answer within 60000ms' }];
    const timeout = await post('/v1/api', { ...TARGET, method: 'GET', path: '/channels' });
    expect(timeout.status).toBe(504);
    resetSessions();
    script = [loginOk(), { failed: 'too_large', detail: 'the response exceeds 1 bytes' }];
    const big = await post('/v1/api', { ...TARGET, method: 'GET', path: '/channels' });
    expect(big.status).toBe(413);
    resetSessions();
    script = [{ failed: 'unreachable', detail: 'could not be reached' }];
    const down = await post('/v1/api', { ...TARGET, method: 'GET', path: '/channels' });
    expect(down.status).toBe(502);
  });
});

describe('test-connection', () => {
  it('logs in with the unsaved credential, reads the version, and logs out', async () => {
    script = [
      loginOk(),
      ok('4.5.2', { headers: { 'content-type': 'text/plain' } }),
      ok('', { status: 204 }),
    ];
    const response = await post('/v1/test-connection', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      credentials: { username: 'carol', password: 'pw2' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ username: 'carol', version: '4.5.2' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls[0].body?.toString()).toBe('username=carol&password=pw2');
    expect(calls[2].url).toBe('https://mirth.example:8443/api/users/_logout');
  });

  it('answers 403 login_failed on a rejected credential and 404 on an unknown instance', async () => {
    script = [{ status: 401, headers: {}, body: Buffer.from('') }];
    const rejected = await post('/v1/test-connection', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      credentials: { username: 'carol', password: 'wrong' },
    });
    expect(rejected.status).toBe(403);
    const missing = await post('/v1/test-connection', {
      tenantId: 'tenant-1',
      instanceId: 'other',
      credentials: { username: 'carol', password: 'pw' },
    });
    expect(missing.status).toBe(404);
  });
});

describe('probe', () => {
  it('treats a 401 from an unsaved URL as reachable, and refuses plaintext unless allowed', async () => {
    script = [{ status: 401, headers: {}, body: Buffer.from('') }];
    const response = await post('/v1/probe', {
      tenantId: 'tenant-1',
      unsaved: { baseUrl: 'https://new.example:8443/', tlsVerify: false },
    });
    expect(await response.json()).toEqual({ ok: true, status: 401, version: null });
    expect(calls[0].url).toBe('https://new.example:8443/api/server/version');
    expect(calls[0].tls.verify).toBe(false);

    const plain = await post('/v1/probe', {
      tenantId: 'tenant-1',
      unsaved: { baseUrl: 'http://lab.example:8080' },
    });
    expect(plain.status).toBe(400);
  });

  it('reports an unreachable server as a successful request with ok: false', async () => {
    script = [{ failed: 'unreachable', detail: 'could not be reached' }];
    const response = await post('/v1/probe', { tenantId: 'tenant-1', instanceId: INSTANCE_ID });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
  });
});

describe('logout', () => {
  it('ends a held session and reports when there was none', async () => {
    const none = await post('/v1/logout', TARGET);
    expect(await none.json()).toEqual({ loggedOut: false });

    script = [loginOk(), ok('1'), ok('', { status: 204 })];
    await post('/v1/api', { ...TARGET, method: 'GET', path: '/server/id' });
    const out = await post('/v1/logout', TARGET);
    expect(await out.json()).toEqual({ loggedOut: true });
    expect(calls[2].url).toBe('https://mirth.example:8443/api/users/_logout');
    expect(calls[2].headers.cookie).toBe('JSESSIONID=s1');
  });
});

/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The HTTP seam's own contract: bearer auth fails closed, the api op
 * resolves the caller's OWN credential and sends it as the Authorization
 * header with no session to hold, test-connection validates an unsaved
 * authtoken against a stored instance, probe treats a 401 as reachable,
 * and the envelope carries the upstream status verbatim. The upstream
 * dialer and the store are injected — the subject is the wire, not
 * ADManager Plus.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InstanceRow, ResolvedTarget } from '@renkei/connector-admanager';
import { createAdManagerServer } from './server';
import type { UpstreamRequest, UpstreamResponse } from './upstream';

const API_KEY = 'test-worker-key';
const INSTANCE_ID = '11111111-2222-3333-4444-555555555555';

const instance: InstanceRow = {
  summary: {
    id: INSTANCE_ID,
    name: 'Prod',
    environment: 'prod',
    baseUrl: 'https://admp.example:8080',
    tlsVerify: false,
    hasCustomCa: false,
    allowInsecureHttp: false,
    resetPasswordTemplateName: null,
    enabled: true,
  },
  caPem: null,
  settings: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const resolved: ResolvedTarget = {
  instance,
  credentials: { authToken: 'tok-alice' },
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

let server: Server;
let base: string;

beforeAll(async () => {
  server = createAdManagerServer({
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
      const response = await post('/v1/api', {}, key);
      expect(response.status).toBe(401);
    }
  });

  it('refuses a GET on an op route', async () => {
    const response = await fetch(`${base}/v1/api`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.status).toBe(405);
  });

  it('refuses an unknown op', async () => {
    const response = await post('/v1/bogus', {});
    expect(response.status).toBe(404);
  });
});

describe('api', () => {
  it('sends the caller’s decrypted authtoken as Authorization, with no session dance', async () => {
    script = [ok('{"data":[]}')];
    const response = await post('/v1/api', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      subject: 'auth0|alice',
      method: 'GET',
      path: '/api/v2/users',
      query: { domains: 'corp.example' },
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.status).toBe(200);
    expect(body.body).toBe('{"data":[]}');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://admp.example:8080/api/v2/users?domains=corp.example');
    expect(calls[0].headers.authorization).toBe('tok-alice');
  });

  it('encodes spaces in query values as %20, not the form-encoded +', async () => {
    // A confirmed production caller of this same API builds its query
    // strings with qs (default RFC 3986: spaces as %20). URLSearchParams'
    // own default (+) would reach ADManager Plus as a literal plus sign
    // rather than a space in any value that has one — a template name, a
    // filter on a display name, a group name.
    script = [ok('{"data":[]}')];
    await post('/v1/api', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      subject: 'auth0|alice',
      method: 'PATCH',
      path: '/api/v2/users',
      query: { domain: 'corp.example', filter: '(DISPLAY_NAME eq "Jane Doe")' },
    });
    expect(calls[0].url).toBe(
      'https://admp.example:8080/api/v2/users?domain=corp.example&filter=%28DISPLAY_NAME%20eq%20%22Jane%20Doe%22%29'
    );
    expect(calls[0].url).not.toContain('+');
  });

  it('sends AuthToken/PRODUCT_NAME as headers and query params for legacy /RestAPI/* paths, never Authorization', async () => {
    script = [ok('[{"status":"1"}]')];
    const response = await post('/v1/api', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      subject: 'auth0|alice',
      method: 'POST',
      path: '/RestAPI/UnlockUser',
      query: { inputFormat: '[{"sAMAccountName":"jdoe"}]', domainName: 'corp.example' },
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers.AuthToken).toBe('tok-alice');
    expect(call.headers.PRODUCT_NAME).toBe('Renkei');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/RestAPI/UnlockUser');
    expect(url.searchParams.get('inputFormat')).toBe('[{"sAMAccountName":"jdoe"}]');
    expect(url.searchParams.get('domainName')).toBe('corp.example');
    expect(url.searchParams.get('AuthToken')).toBe('tok-alice');
    expect(url.searchParams.get('PRODUCT_NAME')).toBe('Renkei');
  });

  it('refuses a bad path or method before dialing anything', async () => {
    const badMethod = await post('/v1/api', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      subject: 'auth0|alice',
      method: 'PUT',
      path: '/api/v2/users',
    });
    expect(badMethod.status).toBe(400);

    const badPath = await post('/v1/api', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      subject: 'auth0|alice',
      method: 'GET',
      path: '/api/v2/../v1/user/unlockUserAccount',
    });
    expect(badPath.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('answers not_connected for an unknown instance/subject without leaking which', async () => {
    const response = await post('/v1/api', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      subject: 'auth0|mallory',
      method: 'GET',
      path: '/api/v2/users',
    });
    expect(response.status).toBe(403);
    const body = await json(response);
    expect(body.error?.type).toBe('not_connected');
  });

  it('forwards an upstream timeout as 504', async () => {
    script = [{ failed: 'timeout', detail: 'did not answer' }];
    const response = await post('/v1/api', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      subject: 'auth0|alice',
      method: 'GET',
      path: '/api/v2/users',
    });
    expect(response.status).toBe(504);
  });
});

describe('test-connection', () => {
  it('accepts an unsaved authtoken that the server answers 200 to', async () => {
    script = [ok('{"data":[]}')];
    const response = await post('/v1/test-connection', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      credentials: { authToken: 'tok-new' },
    });
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe('https://admp.example:8080/api/v1/domain/listDomains');
    expect(calls[0].headers.authorization).toBe('tok-new');
  });

  it('answers bad_credentials on a 401/403 from the server', async () => {
    script = [ok('', { status: 401 })];
    const response = await post('/v1/test-connection', {
      tenantId: 'tenant-1',
      instanceId: INSTANCE_ID,
      credentials: { authToken: 'tok-wrong' },
    });
    expect(response.status).toBe(503);
    const body = await json(response);
    expect(body.error?.type).toBe('bad_credentials');
  });
});

describe('probe', () => {
  it('treats a 401 from the server as reachable, unauthenticated', async () => {
    script = [ok('', { status: 401 })];
    const response = await post('/v1/probe', { tenantId: 'tenant-1', instanceId: INSTANCE_ID });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; status: number };
    expect(body.ok).toBe(true);
    expect(body.status).toBe(401);
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('probes an unsaved baseUrl before anything is stored', async () => {
    script = [ok('', { status: 401 })];
    const response = await post('/v1/probe', {
      tenantId: 'tenant-1',
      unsaved: { baseUrl: 'https://new-admp.example:8080', tlsVerify: true },
    });
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe('https://new-admp.example:8080/api/v1/domain/listDomains');
  });

  it('reports a real failure as ok: false rather than an HTTP error', async () => {
    script = [{ failed: 'unreachable', detail: 'connection refused' }];
    const response = await post('/v1/probe', { tenantId: 'tenant-1', instanceId: INSTANCE_ID });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
  });
});

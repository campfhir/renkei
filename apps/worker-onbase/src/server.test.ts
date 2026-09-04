/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The OnBase worker exercised end-to-end over real sockets, against fake
 * in-process IdP and OnBase API servers — no containers, no network. What
 * these tests pin down is the seam's contract: auth fails closed, hosts
 * come from configuration and never from the caller, upstream statuses
 * reach the web side intact (401 drives its refresh), and invalid_grant is
 * only ever an explicit IdP verdict.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ok, err } from '@campfhir/safe-functions/helpers';
import { createOnBaseServer } from './server';
import type { OnBaseTenantConfig } from './config';

const API_KEY = 'test-worker-key';
const TENANT = '11111111-1111-1111-1111-111111111111';
/** Has the Document connector configured, but never connected onbase-admin. */
const TENANT_NO_ADMIN = '33333333-3333-3333-3333-333333333333';

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** What the fake IdP saw last, for assertions on the wire format. */
let lastTokenForm: URLSearchParams | null = null;
let idpTokenMode: 'ok' | 'invalid_grant' | 'server_error' = 'ok';

function fakeIdp(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://idp.internal');
    if (url.pathname === '/identity/.well-known/openid-configuration') {
      const base = `http://${request.headers.host}/identity`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/connect/authorize`,
          token_endpoint: `${base}/connect/token`,
          revocation_endpoint: `${base}/connect/revocation`,
        })
      );
      return;
    }
    if (url.pathname === '/identity/connect/token') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        lastTokenForm = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        if (idpTokenMode === 'invalid_grant') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        if (idpTokenMode === 'server_error') {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'server_error' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            id_token: 'header.payload.sig',
            expires_in: 3600,
            token_type: 'Bearer',
          })
        );
      });
      return;
    }
    if (url.pathname === '/identity/connect/revocation') {
      response.writeHead(200);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
}

const cookiesSeen: (string | null)[] = [];
let lastContentType: string | null = null;

function fakeOnBase(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://onbase.internal');
    const authenticated = request.headers.authorization === 'Bearer good-token';
    // What the worker sent us, so a test can assert the session was reused
    // rather than a second one created (and a second license taken).
    cookiesSeen.push(request.headers.cookie ?? null);
    if (url.pathname === '/onbase/core/session/disconnect') {
      response.writeHead(request.headers.cookie ? 200 : 400);
      response.end();
      return;
    }
    if (url.pathname === '/onbase/core/document-types') {
      if (!authenticated) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({}));
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'Cookie.Session.OnBase.Hyland=sess-1; path=/; HttpOnly',
      });
      response.end(JSON.stringify({ items: [{ id: '7', name: 'Invoices' }] }));
      return;
    }
    if (url.pathname === '/onbase/core/documents/1/revisions/latest/renditions/default/content') {
      if (!authenticated) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({}));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="doc.txt"',
      });
      response.end('document body bytes');
      return;
    }
    if (url.pathname === '/onbase/core/documents/uploads/u-9' && request.method === 'PUT') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const size = Buffer.concat(chunks).byteLength;
        response.writeHead(size > 0 ? 204 : 400);
        response.end();
      });
      return;
    }
    if (url.pathname === '/onbase/administration/api/document-types/901' && request.method === 'PATCH') {
      lastContentType = request.headers['content-type'] ?? null;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: '901' }));
      return;
    }
    if (url.pathname === '/onbase/administration/api/document-types' && request.method === 'GET') {
      // Unauthenticated on purpose, mirroring /onbase/core/document-types
      // below: a 401 here is test-connection's healthy answer for the
      // onbase-admin connector, and proves it probed THIS path (under
      // /api), not the Document API's /document-types.
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({}));
      return;
    }
    if (url.pathname === '/onbase/administration/api/document-types' && request.method === 'POST') {
      if (!authenticated) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({}));
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const posted: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: '901', ...(typeof posted === 'object' ? posted : {}) }));
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ detail: 'no such route' }));
    return;
  });
}

describe('worker-onbase server', () => {
  const idp = fakeIdp();
  const onbase = fakeOnBase();
  const worker = createOnBaseServer({
    encryptionKey: Buffer.alloc(32),
    apiKeys: [API_KEY],
    maxTransferBytes: () => Promise.resolve(64),
    resolveConfig: (tenantId, connector) => {
      const documentConfig: OnBaseTenantConfig = {
        apiBaseUrl: `${onbaseUrl}/onbase/core`,
        idpIssuer: `${idpUrl}/identity`,
        clientId: 'renkei-client',
        clientSecret: 'shh',
        idpScopeName: 'onbase-api',
        allowInsecureHttp: true,
      };
      const adminConfig: OnBaseTenantConfig = {
        apiBaseUrl: `${onbaseUrl}/onbase/administration`,
        idpIssuer: `${idpUrl}/identity`,
        clientId: 'renkei-admin-client',
        clientSecret: 'shh-admin',
        idpScopeName: 'onbase-admin-api',
        allowInsecureHttp: true,
      };
      if (tenantId === TENANT) {
        return Promise.resolve(ok(connector === 'onbase-admin' ? adminConfig : documentConfig));
      }
      // TENANT_NO_ADMIN has the Document connector configured, but never
      // set up the Administration one — the common real-world case, since
      // they are separately connected Hyland OAuth clients.
      if (tenantId === TENANT_NO_ADMIN) {
        return Promise.resolve(
          connector === 'onbase-admin' ? err('not_configured' as const) : ok(documentConfig)
        );
      }
      return Promise.resolve(err('not_configured' as const));
    },
  });

  let idpUrl = '';
  let onbaseUrl = '';
  let workerUrl = '';

  beforeAll(async () => {
    idpUrl = await listen(idp);
    onbaseUrl = await listen(onbase);
    workerUrl = await listen(worker);
  });

  afterAll(async () => {
    await Promise.all([close(idp), close(onbase), close(worker)]);
  });

  function post(op: string, body: unknown, key: string | null = API_KEY): Promise<Response> {
    return fetch(`${workerUrl}/v1/${op}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('answers /health without auth and refuses ops without the key', async () => {
    const health = await fetch(`${workerUrl}/health`);
    expect(health.status).toBe(200);

    const denied = await post('discover', { tenantId: TENANT }, null);
    expect(denied.status).toBe(401);
    const wrongKey = await post('discover', { tenantId: TENANT }, 'not-the-key');
    expect(wrongKey.status).toBe(401);
  });

  it('discovers the tenant IdP endpoints from stored config', async () => {
    const response = await post('discover', { tenantId: TENANT });
    expect(response.status).toBe(200);
    const endpoints = (await response.json()) as Record<string, string>;
    expect(endpoints.authorizationEndpoint).toBe(`${idpUrl}/identity/connect/authorize`);
    expect(endpoints.tokenEndpoint).toBe(`${idpUrl}/identity/connect/token`);
  });

  it('refuses discovery for an unconfigured tenant', async () => {
    const response = await post('discover', { tenantId: '22222222-2222-2222-2222-222222222222' });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('not_configured');
  });

  it('exchanges an authorization code with PKCE and client auth on the form', async () => {
    idpTokenMode = 'ok';
    const response = await post('token', {
      tenantId: TENANT,
      grant: {
        type: 'authorization_code',
        code: 'code-1',
        redirectUri: 'https://renkei.example/api/oauth/callback',
        codeVerifier: 'verifier-1',
      },
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as Record<string, unknown>;
    expect(tokens.access_token).toBe('at-1');
    expect(lastTokenForm?.get('grant_type')).toBe('authorization_code');
    expect(lastTokenForm?.get('code_verifier')).toBe('verifier-1');
    expect(lastTokenForm?.get('client_id')).toBe('renkei-client');
    expect(lastTokenForm?.get('client_secret')).toBe('shh');
  });

  it('refreshes with a refresh token', async () => {
    idpTokenMode = 'ok';
    const response = await post('token', {
      tenantId: TENANT,
      grant: { type: 'refresh_token', refreshToken: 'rt-0' },
    });
    expect(response.status).toBe(200);
    expect(lastTokenForm?.get('grant_type')).toBe('refresh_token');
    expect(lastTokenForm?.get('refresh_token')).toBe('rt-0');
  });

  it('maps an explicit invalid_grant, and only that, onto invalid_grant', async () => {
    idpTokenMode = 'invalid_grant';
    const revoked = await post('token', {
      tenantId: TENANT,
      grant: { type: 'refresh_token', refreshToken: 'rt-dead' },
    });
    expect(revoked.status).toBe(400);
    expect(((await revoked.json()) as { error: { type: string } }).error.type).toBe(
      'invalid_grant'
    );

    idpTokenMode = 'server_error';
    const flaky = await post('token', {
      tenantId: TENANT,
      grant: { type: 'refresh_token', refreshToken: 'rt-0' },
    });
    expect(flaky.status).toBe(502);
    expect(((await flaky.json()) as { error: { type: string } }).error.type).toBe('token_failed');
    idpTokenMode = 'ok';
  });

  it('reports revocation as best-effort success', async () => {
    const response = await post('revoke', { tenantId: TENANT, token: 'rt-1' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { revoked: boolean }).revoked).toBe(true);
  });

  it('proxies an api call and envelopes the upstream status', async () => {
    const good = await post('api', {
      tenantId: TENANT,
      accessToken: 'good-token',
      method: 'GET',
      path: '/document-types',
    });
    expect(good.status).toBe(200);
    const envelope = (await good.json()) as { status: number; body: string };
    expect(envelope.status).toBe(200);
    expect(JSON.parse(envelope.body)).toEqual({ items: [{ id: '7', name: 'Invoices' }] });

    const unauthorized = await post('api', {
      tenantId: TENANT,
      accessToken: 'stale-token',
      method: 'GET',
      path: '/document-types',
    });
    expect(unauthorized.status).toBe(200);
    expect(((await unauthorized.json()) as { status: number }).status).toBe(401);
  });

  it('refuses paths that climb or smuggle a second URL', async () => {
    for (const path of ['document-types', '/a/../b', '/x/https://evil', '//evil/path']) {
      const response = await post('api', {
        tenantId: TENANT,
        accessToken: 'good-token',
        method: 'GET',
        path,
      });
      expect(response.status).toBe(400);
    }
  });

  it('streams content within the transfer cap and forwards upstream 401', async () => {
    const content = await fetch(`${workerUrl}/v1/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        tenantId: TENANT,
        accessToken: 'good-token',
        path: '/documents/1/revisions/latest/renditions/default/content',
      }),
    });
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toContain('text/plain');
    expect(content.headers.get('content-disposition')).toContain('doc.txt');
    expect(await content.text()).toBe('document body bytes');

    const stale = await post('content', {
      tenantId: TENANT,
      accessToken: 'stale-token',
      path: '/documents/1/revisions/latest/renditions/default/content',
    });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: { type: string } }).error.type).toBe('api_error');
  });

  it('puts upload bytes through to the staging slot', async () => {
    const response = await fetch(
      `${workerUrl}/v1/put-bytes?tenantId=${TENANT}&uploadId=u-9&filePart=1`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'x-onbase-token': 'good-token',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array([1, 2, 3]),
      }
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: number }).status).toBe(204);
  });

  it('rejects an oversized upload part with too_large', async () => {
    const response = await fetch(
      `${workerUrl}/v1/put-bytes?tenantId=${TENANT}&uploadId=u-9&filePart=1`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'x-onbase-token': 'good-token',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array(65),
      }
    );
    expect(response.status).toBe(413);
  });

  it('tests the unsaved payload and treats an API 401 as reachable', async () => {
    const response = await post('test-connection', {
      tenantId: TENANT,
      unsaved: {
        apiBaseUrl: `${onbaseUrl}/onbase/core`,
        idpIssuer: `${idpUrl}/identity`,
        allowInsecureHttp: true,
      },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      idp: { ok: boolean };
      api: { ok: boolean; status?: number };
    };
    expect(result.idp.ok).toBe(true);
    expect(result.api).toEqual({ ok: true, status: 401 });
  });

  it('reports an unreachable API server without failing the request', async () => {
    const response = await post('test-connection', {
      tenantId: TENANT,
      unsaved: {
        apiBaseUrl: 'http://127.0.0.1:1/onbase/core',
        idpIssuer: `${idpUrl}/identity`,
        allowInsecureHttp: true,
      },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { api: { ok: boolean; error?: string } };
    expect(result.api.ok).toBe(false);
  });

  it('reuses the OnBase session cookie instead of taking a licence per call', async () => {
    // An access token alone creates nothing; the FIRST authenticated request
    // builds a session and consumes a licence. Sending its cookie back is the
    // whole reason a ten-document sweep costs one licence and not ten.
    cookiesSeen.length = 0;
    const call = () =>
      post('api', {
        tenantId: TENANT,
        subject: 'subject-1',
        accessToken: 'good-token',
        method: 'GET',
        path: '/document-types',
      });

    await call();
    await call();

    expect(cookiesSeen[0]).toBeNull();
    expect(cookiesSeen[1]).toBe('Cookie.Session.OnBase.Hyland=sess-1');
  });

  it('keeps one caller off another caller’s session', async () => {
    cookiesSeen.length = 0;
    await post('api', {
      tenantId: TENANT,
      subject: 'subject-a',
      accessToken: 'good-token',
      method: 'GET',
      path: '/document-types',
    });
    await post('api', {
      tenantId: TENANT,
      subject: 'subject-b',
      accessToken: 'good-token',
      method: 'GET',
      path: '/document-types',
    });

    // b must open its own session — reusing a's would act in OnBase as a.
    expect(cookiesSeen[1]).toBeNull();
  });

  it('ends a session on disconnect so the licence comes back early', async () => {
    await post('api', {
      tenantId: TENANT,
      subject: 'subject-d',
      accessToken: 'good-token',
      method: 'GET',
      path: '/document-types',
    });

    const first = await post('disconnect', {
      tenantId: TENANT,
      subject: 'subject-d',
      accessToken: 'good-token',
    });
    expect(await first.json()).toEqual({ disconnected: true });

    // Nothing left to disconnect: the API is not called just to be told to
    // close a session it would have had to open first.
    const second = await post('disconnect', {
      tenantId: TENANT,
      subject: 'subject-d',
      accessToken: 'good-token',
    });
    expect(await second.json()).toEqual({ disconnected: false });
  });

  it('proxies an api call for the onbase-admin connector against its own base, not the Document API', async () => {
    const response = await post('api', {
      tenantId: TENANT,
      connector: 'onbase-admin',
      accessToken: 'good-token',
      method: 'POST',
      path: '/api/document-types',
      body: { name: 'Employee Profile' },
    });
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as { status: number; body: string };
    expect(envelope.status).toBe(200);
    expect(JSON.parse(envelope.body)).toMatchObject({ id: '901', name: 'Employee Profile' });
  });

  it('sends no OnBase session cookie for onbase-admin, even for a subject with a live Document session', async () => {
    // Prime a Document API session for this subject first.
    await post('api', {
      tenantId: TENANT,
      subject: 'subject-admin',
      accessToken: 'good-token',
      method: 'GET',
      path: '/document-types',
    });
    cookiesSeen.length = 0;
    await post('api', {
      tenantId: TENANT,
      connector: 'onbase-admin',
      subject: 'subject-admin',
      accessToken: 'good-token',
      method: 'POST',
      path: '/api/document-types',
      body: { name: 'No Cookie Here' },
    });
    expect(cookiesSeen[0]).toBeNull();
  });

  it('sends PATCH bodies as application/json-patch+json, not plain JSON', async () => {
    lastContentType = null;
    const response = await post('api', {
      tenantId: TENANT,
      connector: 'onbase-admin',
      accessToken: 'good-token',
      method: 'PATCH',
      path: '/api/document-types/901',
      body: [{ op: 'replace', path: '/name', value: 'Renamed' }],
    });
    expect(response.status).toBe(200);
    expect(lastContentType).toBe('application/json-patch+json');
  });

  it('refuses onbase-admin calls for a tenant that never connected it', async () => {
    const response = await post('api', {
      tenantId: TENANT_NO_ADMIN,
      connector: 'onbase-admin',
      accessToken: 'good-token',
      method: 'GET',
      path: '/api/document-types',
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
      'not_configured'
    );
  });

  it('tests the onbase-admin connection against its own /api/document-types probe path', async () => {
    const response = await post('test-connection', {
      tenantId: TENANT,
      connector: 'onbase-admin',
      unsaved: {
        apiBaseUrl: `${onbaseUrl}/onbase/administration`,
        idpIssuer: `${idpUrl}/identity`,
        allowInsecureHttp: true,
      },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { api: { ok: boolean; status?: number } };
    // 401 on /api/document-types (not the Document API's /document-types,
    // which would 401 too but is the wrong host path entirely) proves the
    // onbase-admin probe used the Administration API's own vocabulary path.
    expect(result.api).toEqual({ ok: true, status: 401 });
  });
});

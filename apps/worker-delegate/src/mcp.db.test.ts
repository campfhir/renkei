/**
 * `mcp/prepare` against the dev database with a scripted network: discovery
 * of the authorization server, dynamic client registration, the refusal of
 * an authorization server that is not a public address, a server that needs
 * no sign-in, and one that offers no registration. Needs DATABASE_URL and
 * TOKEN_ENCRYPTION_KEY.
 */

import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase } from '@renkei/db';
import { decrypt, parseEncryptionKey } from '@renkei/crypto';
import {
  createServer,
  deleteServer,
  getSealedClientSecret,
  getServer,
} from '@renkei/connector-mcp';
import { McpPreparer } from './mcp';

const describeDb =
  process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? describe : describe.skip;

const ORIGIN = 'https://mcp.example.test';
const AUTH = 'https://auth.example.test';
const REDIRECT = 'https://renkei.example.test/api/oauth/callback';

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** A ServerResponse that only remembers what sendJson wrote. */
function capture(): { response: ServerResponse; answer: () => Answer } {
  let status = 0;
  let payload = '';
  const response = {
    writeHead(code: number) {
      status = code;
    },
    end(text: string) {
      payload = text;
    },
  };
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a stand-in with the two methods sendJson calls
    response: response as unknown as ServerResponse,
    answer: () => ({ status, body: JSON.parse(payload) }),
  };
}

function loadKey() {
  const parsed = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!parsed.ok) throw new Error('bad key');
  return parsed.val;
}

describeDb('mcp/prepare', () => {
  // Parsed in beforeAll: a skipped describe still runs its body, and CI has no key.
  let key: ReturnType<typeof loadKey>;
  const created: string[] = [];
  const requests: { url: string; method: string; body: string }[] = [];
  let script: (url: string, init: RequestInit | undefined) => Response;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    return script(url, init);
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const authMetadata = {
    issuer: AUTH,
    authorization_endpoint: `${AUTH}/authorize`,
    token_endpoint: `${AUTH}/token`,
    registration_endpoint: `${AUTH}/register`,
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:read'],
  };

  /** A server that 401s, names its resource metadata, and has the metadata above. */
  function protectedServer(overrides: { registration?: boolean } = {}) {
    return (url: string, init: RequestInit | undefined): Response => {
      if (url === `${ORIGIN}/mcp`) {
        return new Response('no', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      if (url.startsWith(`${ORIGIN}/.well-known/oauth-protected-resource`)) {
        return json({ resource: `${ORIGIN}/mcp`, authorization_servers: [AUTH] });
      }
      if (url.startsWith(`${AUTH}/.well-known/oauth-authorization-server`)) {
        const metadata: Record<string, unknown> = { ...authMetadata };
        if (overrides.registration === false) delete metadata.registration_endpoint;
        return json(metadata);
      }
      if (url === `${AUTH}/register` && init?.method === 'POST') {
        return json({ client_id: 'registered-client', client_secret: 'registered-secret' }, 201);
      }
      return new Response('unexpected', { status: 500 });
    };
  }

  async function makeServer(slug: string, authMode: 'oauth' | 'none' = 'oauth') {
    const db = getDatabase();
    if (!db.ok) throw new Error('database unavailable');
    const made = await createServer(db.val, {
      slug,
      name: slug,
      url: `${ORIGIN}/mcp`,
      transport: 'streamable_http',
      authMode,
      context: '',
      scopes: null,
      clientId: null,
      encryptedClientSecret: null,
      enabled: true,
    });
    if (!made.ok) throw new Error('could not create the server');
    created.push(made.val.id);
    return made.val;
  }

  async function prepare(serverId: string, assertPublic = async () => undefined) {
    const db = getDatabase();
    if (!db.ok) throw new Error('database unavailable');
    const out = capture();
    await new McpPreparer(db.val, key, fetchImpl, assertPublic).prepare(
      { serverId, redirectUri: REDIRECT },
      out.response
    );
    return out.answer();
  }

  beforeAll(() => {
    key = loadKey();
  });

  beforeEach(() => {
    requests.length = 0;
  });

  afterAll(async () => {
    const db = getDatabase();
    if (db.ok) for (const id of created) await deleteServer(db.val, id);
    await closeDatabase();
  });

  it('discovers the authorization server, registers Renkei, and seals the issued secret', async () => {
    script = protectedServer();
    const server = await makeServer(`e2e_${randomUUID().slice(0, 8)}`);
    const answer = await prepare(server.id);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      authMode: 'oauth',
      authorizationEndpoint: `${AUTH}/authorize`,
      clientId: 'registered-client',
      scope: 'mcp:read',
      resource: `${ORIGIN}/mcp`,
    });

    const registration = requests.find((r) => r.url === `${AUTH}/register`);
    expect(JSON.parse(registration?.body ?? '{}')).toMatchObject({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code', 'refresh_token'],
    });

    const db = getDatabase();
    if (!db.ok) throw new Error('database unavailable');
    const stored = await getServer(db.val, server.id);
    expect(stored.ok && stored.val?.clientId).toBe('registered-client');
    expect(stored.ok && stored.val?.oauth?.tokenEndpoint).toBe(`${AUTH}/token`);
    // The secret is sealed, and only the delegate's key opens it.
    const sealed = await getSealedClientSecret(db.val, server.id);
    expect(sealed.ok && sealed.val).toBeTruthy();
    expect(sealed.ok && sealed.val && decrypt(sealed.val, key)).toMatchObject({
      ok: true,
      val: 'registered-secret',
    });
  });

  it('reuses what it learned: a second prepare neither rediscovers nor registers again', async () => {
    script = protectedServer();
    const server = await makeServer(`e2e_${randomUUID().slice(0, 8)}`);
    await prepare(server.id);
    requests.length = 0;
    const answer = await prepare(server.id);
    expect(answer.status).toBe(200);
    expect(requests).toEqual([]);
  });

  it('asks for a client ID when the authorization server offers no registration', async () => {
    script = protectedServer({ registration: false });
    const server = await makeServer(`e2e_${randomUUID().slice(0, 8)}`);
    const answer = await prepare(server.id);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: { type: 'NEEDS_CLIENT' } });
  });

  it('refuses an authorization server the MCP server names that is not a public address', async () => {
    script = protectedServer();
    const server = await makeServer(`e2e_${randomUUID().slice(0, 8)}`);
    const answer = await prepare(server.id, async () => {
      throw new Error('resolves to a private address');
    });
    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ error: { type: 'DISCOVERY_FAILED' } });
    expect(JSON.stringify(answer.body)).toContain('private address');
    // Nothing was registered with a server the guard refused.
    expect(requests.some((r) => r.url === `${AUTH}/register`)).toBe(false);
  });

  it('reports a server that needs no sign-in as open', async () => {
    script = (url) =>
      url === `${ORIGIN}/mcp` ? json({ jsonrpc: '2.0', id: 1, result: {} }) : json({}, 404);
    const server = await makeServer(`e2e_${randomUUID().slice(0, 8)}`);
    const answer = await prepare(server.id);
    expect(answer.body).toMatchObject({ authMode: 'none', open: true });
  });

  it('answers unknown_server for an id it has no row for', async () => {
    script = protectedServer();
    const answer = await prepare(randomUUID());
    expect(answer.status).toBe(404);
  });
});

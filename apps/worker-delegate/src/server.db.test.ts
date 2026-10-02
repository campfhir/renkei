/**
 * The delegate against the dev database: the key ops answer a resource's
 * key exactly as @renkei/user-keys would, person-only values round-trip,
 * and the proxy attaches a stored grant's token to a request bound for
 * the provider's own host — and to nowhere else. Needs DATABASE_URL and
 * a 32-byte USER_KEY_ENCRYPTION_KEY (TOKEN_ENCRYPTION_KEY stands in when
 * the dedicated one is unset, as the repo-root .env.development has only
 * that one).
 */

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { getDatabase, closeDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { setGrant, GITHUB } from '@renkei/provider-grants';
import { createDelegateServer } from './server';

process.env.USER_KEY_ENCRYPTION_KEY ||= process.env.TOKEN_ENCRYPTION_KEY;

const describeDb =
  process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? describe : describe.skip;

describeDb('worker-delegate', () => {
  const API_KEY = 'test-delegate-key';
  const tenantId = randomUUID();
  const owner = `owner-${randomUUID()}@example.com`;
  const friend = `friend-${randomUUID()}@example.com`;
  let server: Server;
  let base = '';
  const upstreamCalls: {
    url: string;
    authorization: string | null;
    method: string;
    body: string;
  }[] = [];

  beforeAll(async () => {
    const db = getDatabase();
    if (!db.ok) throw new Error('database unavailable');
    await db.val
      .insertInto('tenants')
      .values({ id: tenantId, slug: `delegate-${tenantId.slice(0, 8)}` })
      .execute();
    const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (!key.ok) throw new Error('bad key');
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const body = init?.body;
      upstreamCalls.push({
        url,
        authorization: headers.get('authorization'),
        method: init?.method ?? 'GET',
        body: body
          ? Buffer.from(body instanceof Uint8Array ? body : String(body)).toString('utf8')
          : '',
      });
      return new Response(JSON.stringify({ hello: 'world' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-upstream': 'yes',
          'set-cookie': 'nope=1',
        },
      });
    };
    server = createDelegateServer({
      db: db.val,
      encryptionKey: key.val,
      apiKeys: [API_KEY],
      fetchImpl,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const db = getDatabase();
    if (db.ok) {
      await db.val.deleteFrom('provider_grants').where('tenant_id', '=', tenantId).execute();
      await db.val.deleteFrom('resource_keys').where('tenant_id', '=', tenantId).execute();
      await db.val.deleteFrom('user_encryption_keys').where('tenant_id', '=', tenantId).execute();
      await db.val.deleteFrom('tenants').where('id', '=', tenantId).execute();
    }
    await closeDatabase();
  });

  async function op(
    name: string,
    body: unknown,
    apiKey = API_KEY
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${base}/v1/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => ({}));
    return {
      status: response.status,
      json:
        typeof json === 'object' && json !== null ? Object.fromEntries(Object.entries(json)) : {},
    };
  }

  it('refuses without the bearer key and names an unknown op', async () => {
    expect((await op('resource-key/has', {}, 'wrong')).status).toBe(401);
    expect((await op('nope', {})).status).toBe(404);
  });

  it('mints, opens, shares and revokes a resource key', async () => {
    const chatId = randomUUID();
    const ref = { tenantId, kind: 'chat', resourceId: chatId };
    const minted = await op('resource-key/ensure', { ...ref, ownerSubject: owner });
    expect(minted.status).toBe(200);
    expect(typeof minted.json.id).toBe('string');
    expect(Buffer.from(String(minted.json.key), 'base64').byteLength).toBe(32);

    const again = await op('resource-key/open', { ...ref, subject: owner });
    expect(again.json.key).toBe(minted.json.key);

    const stranger = await op('resource-key/open', { ...ref, subject: friend });
    expect(stranger.status).toBe(403);
    expect((stranger.json.error as { type: string }).type).toBe('NO_ACCESS');

    expect(
      (await op('resource-key/share', { ...ref, fromSubject: owner, toSubject: friend })).status
    ).toBe(200);
    const shared = await op('resource-key/open', { ...ref, subject: friend });
    expect(shared.json.key).toBe(minted.json.key);

    const many = await op('resource-key/open-many', {
      tenantId,
      kind: 'chat',
      entries: [
        { resourceId: chatId, subject: friend },
        { resourceId: randomUUID(), subject: friend },
      ],
    });
    expect(Object.keys(many.json.keys as object)).toEqual([chatId]);

    expect((await op('resource-key/revoke', { ...ref, subject: friend })).json.revoked).toBe(true);
    expect((await op('resource-key/open', { ...ref, subject: friend })).status).toBe(403);
    expect((await op('resource-key/has', ref)).json.exists).toBe(true);
    expect((await op('resource-key/delete', ref)).status).toBe(200);
    expect((await op('resource-key/has', ref)).json.exists).toBe(false);
  });

  it('seals and opens person-only values, null where one will not open', async () => {
    const sealed = await op('user-sealed/seal', {
      tenantId,
      subject: owner,
      values: ['one', 'two'],
    });
    expect(sealed.status).toBe(200);
    const [a, b] = sealed.json.sealed as string[];
    expect(a.startsWith('uenc1:')).toBe(true);
    const opened = await op('user-sealed/open', {
      tenantId,
      subject: owner,
      stored: [b, a, 'uenc1:garbage'],
    });
    expect(opened.json.opened).toEqual(['two', 'one', null]);
    const other = await op('user-sealed/open', { tenantId, subject: friend, stored: [a] });
    expect(other.json.opened).toEqual([null]);
  });

  it('reports a managed key status', async () => {
    const status = await op('own-key/status', { tenantId, subject: owner });
    expect(status.json.mode).toBe('managed');
    expect(status.json.locked).toBe(false);
  });

  it('proxies a request on a stored grant with the token attached, and only to the provider', async () => {
    const accountId = `gh-${randomUUID().slice(0, 8)}`;
    const saved = await setGrant(GITHUB, tenantId, {
      accountId,
      clientId: 'client',
      displayName: 'Octo',
      accessToken: 'gho_secret',
      refreshToken: 'ghr_secret',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      requestedScopes: ['repo'],
      grantedScopes: null,
      metadata: { login: 'octo' },
      subject: owner,
    });
    expect(saved.ok).toBe(true);

    const grant = { tenantId, provider: GITHUB, subject: owner };
    const proxied = await fetch(`${base}/v1/api`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'x-delegate-grant': JSON.stringify(grant),
        'x-delegate-url': 'https://api.github.com/user/repos?per_page=1',
        'x-delegate-method': 'POST',
        'x-delegate-headers': JSON.stringify({
          accept: 'application/vnd.github+json',
          authorization: 'Bearer forged',
        }),
      },
      body: '{"name":"x"}',
    });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('x-upstream')).toBe('yes');
    expect(proxied.headers.get('set-cookie')).toBeNull();
    expect(await proxied.json()).toEqual({ hello: 'world' });
    const call = upstreamCalls.at(-1);
    expect(call?.url).toBe('https://api.github.com/user/repos?per_page=1');
    expect(call?.authorization).toBe('Bearer gho_secret');
    expect(call?.method).toBe('POST');
    expect(call?.body).toBe('{"name":"x"}');

    const elsewhere = await fetch(`${base}/v1/api`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'x-delegate-grant': JSON.stringify(grant),
        'x-delegate-url': 'https://evil.example.com/steal',
        'x-delegate-method': 'GET',
      },
    });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.headers.get('x-delegate-error')).toBe('host_not_allowed');

    const described = await op('grant/describe', grant);
    expect(described.json.accountId).toBe(accountId);
    expect(JSON.stringify(described.json)).not.toContain('gho_secret');

    expect((await op('grant/delete', { tenantId, provider: GITHUB, accountId })).status).toBe(200);
    expect((await op('grant/describe', grant)).status).toBe(404);
  });
});

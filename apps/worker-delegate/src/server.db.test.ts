/**
 * The delegate against the dev database: the key ops answer a resource's
 * key exactly as @renkei/user-keys would, person-only values round-trip,
 * and the proxy attaches a stored grant's token to a request bound for
 * the provider's own host — and to nowhere else. The people in it enroll
 * the way a browser would (user-keys' test support), so every key op runs
 * through a delegation sealed to the test's own instance; no master is
 * involved. Needs DATABASE_URL and TOKEN_ENCRYPTION_KEY.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { getDatabase, closeDatabase } from '@renkei/db';
import { instanceListMessage, parseEncryptionKey, verifyEd25519 } from '@renkei/crypto';
import { setGrant, GITHUB } from '@renkei/provider-grants';
import { createInstance, upsertConnection } from '@renkei/connector-mirth';
import { sealForSubject } from '@renkei/user-keys';
import { Readable } from 'node:stream';
import { setKeyVault } from '@renkei/user-keys';
import {
  enrollTestPerson,
  registerTestInstance,
  sealDelegations,
  type BrowserKeys,
  type TestInstance,
} from '@renkei/user-keys/test-support';
import { createDelegateServer } from './server';
import type { GitDialer } from './git';
import { loadOrCreateSigningKey } from './signing';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorType(json: Record<string, unknown>): string | null {
  return isRecord(json.error) && typeof json.error.type === 'string' ? json.error.type : null;
}

const describeDb =
  process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? describe : describe.skip;

describeDb('worker-delegate', () => {
  const API_KEY = 'test-delegate-key';
  const AGENTS_KEY = 'test-agents-key';
  const WORKER_KEY = 'test-worker-key';
  const tenantId = randomUUID();
  const owner = `owner-${randomUUID()}@example.com`;
  const friend = `friend-${randomUUID()}@example.com`;
  const leaver = `leaver-${randomUUID()}@example.com`;
  let friendSessionId = '';
  let server: Server;
  let base = '';
  let instance: TestInstance;
  let ownerSessionId = '';
  let ownerKeys: BrowserKeys | null = null;
  const upstreamCalls: {
    url: string;
    authorization: string | null;
    method: string;
    body: string;
    headers: Record<string, string>;
    redirect: RequestInit['redirect'] | null;
  }[] = [];
  const gitCalls: { url: string; method: string; headers: Record<string, string>; body: string }[] =
    [];
  /** A test may script the next upstream answers; the default is a 200 with a small JSON body. */
  const scriptedAnswers: ((url: string, init: RequestInit | undefined) => Response | null)[] = [];

  beforeAll(async () => {
    const db = getDatabase();
    if (!db.ok) throw new Error('database unavailable');
    await db.val
      .insertInto('tenants')
      .values({ id: tenantId, slug: `delegate-${tenantId.slice(0, 8)}` })
      .execute();
    const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (!key.ok) throw new Error('bad key');
    instance = await registerTestInstance(db.val);
    const targets = [{ id: instance.id, publicKey: instance.pair.publicKey }];
    const enrolledOwner = await enrollTestPerson(db.val, {
      tenantId,
      subject: owner,
      instances: targets,
    });
    ownerSessionId = enrolledOwner.sessionId;
    ownerKeys = enrolledOwner.keys;
    friendSessionId = (
      await enrollTestPerson(db.val, { tenantId, subject: friend, instances: targets })
    ).sessionId;
    await enrollTestPerson(db.val, { tenantId, subject: leaver, instances: targets });
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
        headers: Object.fromEntries(headers.entries()),
        redirect: init?.redirect ?? null,
      });
      const scripted = scriptedAnswers.shift();
      const answer = scripted ? scripted(url, init) : null;
      if (answer) return answer;
      return new Response(JSON.stringify({ hello: 'world' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-upstream': 'yes',
          'set-cookie': 'nope=1',
        },
      });
    };
    const gitDialer: GitDialer = async (target, init) => {
      const chunks: Buffer[] = [];
      if (init.body) for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      gitCalls.push({
        url: target.toString(),
        method: init.method,
        headers: init.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      return {
        status: 200,
        headers: {
          'content-type': 'application/x-git-upload-pack-advertisement',
          'transfer-encoding': 'chunked',
          'x-git-upstream': 'yes',
        },
        body: Readable.from([Buffer.from('001e# service=git-upload-pack\n0000')]),
      };
    };
    server = createDelegateServer({
      db: db.val,
      encryptionKey: key.val,
      signer: loadOrCreateSigningKey(db.val, key.val, {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
      // The plain string is the web app's key (the shared-key form from before);
      // the named ones are the workers'.
      apiKeys: [API_KEY, { name: 'agents', key: AGENTS_KEY }, { name: 'worker', key: WORKER_KEY }],
      fetchImpl,
      gitDialer,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setKeyVault(null);
    const db = getDatabase();
    if (db.ok) {
      await db.val.deleteFrom('delegate_instances').where('id', '=', instance.id).execute();
      await db.val.deleteFrom('provider_grants').where('tenant_id', '=', tenantId).execute();
      await db.val.deleteFrom('delegate_git_tickets').where('tenant_id', '=', tenantId).execute();
      await db.val.deleteFrom('agents').where('tenant_id', '=', tenantId).execute();
      await db.val.deleteFrom('delegate_signing_keys').execute();
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

  it('lets each caller run only its own ops: the agents key is refused a shred the web key may do', async () => {
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const refused = await op('keys/shred', { tenantId, subject: leaver }, AGENTS_KEY);
    expect(refused.status).toBe(403);
    expect(errorType(refused.json)).toBe('forbidden');
    expect((await op('keys/shred', { tenantId, subject: leaver }, WORKER_KEY)).status).toBe(403);
    expect((await op('keys/status', { tenantId, subject: leaver })).json.enrolled).toBe(true);

    const shredded = await op('keys/shred', { tenantId, subject: leaver });
    expect(shredded.status).toBe(200);
    expect(shredded.json.shredded).toBe(true);
    expect((await op('keys/status', { tenantId, subject: leaver })).json.enrolled).toBe(false);

    // The shred left an append-only access row naming the caller, not the key or the person.
    const events = await dbResult.val
      .selectFrom('delegate_access_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('op', '=', 'keys/shred')
      .execute();
    expect(events.map((event) => [event.caller, event.outcome, event.status])).toEqual(
      expect.arrayContaining([['web', 'ok', 200]])
    );
    const refusals = await dbResult.val
      .selectFrom('delegate_access_events')
      .select(['caller', 'outcome', 'status'])
      .where('op', '=', 'keys/shred')
      .where('caller', 'in', ['agents', 'worker'])
      .where('created_at', '>', new Date(Date.now() - 60_000))
      .execute();
    expect(refusals).toEqual(
      expect.arrayContaining([
        { caller: 'agents', outcome: 'refused', status: 403 },
        { caller: 'worker', outcome: 'refused', status: 403 },
      ])
    );
    expect(JSON.stringify(events)).not.toContain(leaver);
    await expect(
      dbResult.val.deleteFrom('delegate_access_events').where('id', '=', events[0]!.id).execute()
    ).rejects.toThrow(/append-only/);
  });

  it("binds an op to the session it names: another session of the same person, or anyone else's, is refused", async () => {
    const chatId = randomUUID();
    const ref = { tenantId, kind: 'chat', resourceId: chatId };
    expect((await op('resource-key/ensure', { ...ref, ownerSubject: owner })).status).toBe(200);
    const bound = await op('resource-key/open', {
      ...ref,
      subject: owner,
      sessionId: ownerSessionId,
    });
    expect(bound.status).toBe(200);
    const mismatched = await op('resource-key/open', {
      ...ref,
      subject: owner,
      sessionId: friendSessionId,
    });
    expect(mismatched.status).toBe(403);
    expect(errorType(mismatched.json)).toBe('SESSION_MISMATCH');
    const madeUp = await op('keys/status', { tenantId, subject: owner, sessionId: randomUUID() });
    expect(madeUp.status).toBe(403);
    expect(errorType(madeUp.json)).toBe('SESSION_MISMATCH');
    // A delegation for a session that is not the person's binds nothing.
    const stolen = await op('keys/delegate', {
      tenantId,
      subject: owner,
      sessionId: friendSessionId,
      session: [],
      automation: [],
    });
    expect(stolen.status).toBe(403);
    expect(errorType(stolen.json)).toBe('SESSION_MISMATCH');
    // The owner's other session, once it exists and is theirs, opens through its own delegation only.
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const secondSession = randomUUID();
    await dbResult.val
      .insertInto('sessions')
      .values({
        id: secondSession,
        tenant_id: tenantId,
        subject: owner,
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .execute();
    const undelegated = await op('resource-key/open', {
      ...ref,
      subject: owner,
      sessionId: secondSession,
    });
    // Only the automation ring is reachable through that session: the owner's
    // own wrapping needs the person present, so the op says NEEDS_SESSION.
    expect(undelegated.status).toBe(423);
    expect(errorType(undelegated.json)).toBe('NEEDS_SESSION');
    await op('resource-key/delete', ref);
  });

  it('never opens a session ring for a worker, and makes the agents worker name its run', async () => {
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const db = dbResult.val;
    // The queue worker mints a chat note's key: wrapped under the owner's
    // automation key, since the session key is not the worker's to hold.
    const chatId = randomUUID();
    const ref = { tenantId, kind: 'chat', resourceId: chatId };
    const minted = await op('resource-key/ensure', { ...ref, ownerSubject: owner }, WORKER_KEY);
    expect(minted.status).toBe(200);
    const holders = await op('resource-key/holders', ref);
    expect(
      (Array.isArray(holders.json.holders) ? holders.json.holders : []).map((holder) =>
        isRecord(holder) ? holder.holderKind : null
      )
    ).toEqual(['automation']);
    // A value under the user key alone is out of a worker's reach, whatever op it tries.
    expect(
      (await op('user-sealed/open', { tenantId, subject: owner, stored: [] }, WORKER_KEY)).status
    ).toBe(403);

    // The agents worker asks about a run's owner: without the run, or with
    // somebody else's run, it is refused; with the owner's run it is answered.
    const agentId = randomUUID();
    const runId = randomUUID();
    await db
      .insertInto('agents')
      .values({ id: agentId, tenant_id: tenantId, owner_subject: owner, name: 'r24', steps: '[]' })
      .execute();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        tenant_id: tenantId,
        agent_id: agentId,
        owner_subject: owner,
        steps_snapshot: '[]',
        trigger_kind: 'manual',
      })
      .execute();
    const unnamed = await op('keys/status', { tenantId, subject: owner }, AGENTS_KEY);
    expect(unnamed.status).toBe(403);
    expect(errorType(unnamed.json)).toBe('RUN_MISMATCH');
    const wrongOwner = await op('keys/status', { tenantId, subject: friend, runId }, AGENTS_KEY);
    expect(wrongOwner.status).toBe(403);
    const named = await op('keys/status', { tenantId, subject: owner, runId }, AGENTS_KEY);
    expect(named.status).toBe(200);
    expect(named.json.enrolled).toBe(true);
    await op('resource-key/delete', ref);
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
    expect(errorType(stranger.json)).toBe('NO_ACCESS');

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
    expect(Object.keys(isRecord(many.json.keys) ? many.json.keys : {})).toEqual([chatId]);

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
    const list = Array.isArray(sealed.json.sealed) ? sealed.json.sealed : [];
    const a = String(list[0]);
    const b = String(list[1]);
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

  it('reports enrollment and delegations, takes fresh ones, and revokes automation', async () => {
    const instances = await op('keys/instances', {});
    expect(instances.json.instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: instance.id,
          publicKey: instance.pair.publicKey.toString('base64'),
        }),
      ])
    );
    // The list is signed by the deployment's key, over the canonical message
    // a browser rebuilds; a list with one more instance is not.
    const listed = Array.isArray(instances.json.instances) ? instances.json.instances : [];
    const signed = listed.flatMap((item) =>
      isRecord(item) && typeof item.id === 'string' && typeof item.publicKey === 'string'
        ? [{ id: item.id, publicKey: item.publicKey }]
        : []
    );
    const signingKey = Buffer.from(String(instances.json.signingKey), 'base64');
    const signature = Buffer.from(String(instances.json.signature), 'base64');
    expect(signingKey.byteLength).toBe(32);
    expect(verifyEd25519(signingKey, Buffer.from(instanceListMessage(signed)), signature)).toBe(
      true
    );
    const planted = [
      ...signed,
      { id: randomUUID(), publicKey: randomBytes(32).toString('base64') },
    ];
    expect(verifyEd25519(signingKey, Buffer.from(instanceListMessage(planted)), signature)).toBe(
      false
    );
    // The same key on the next boot: one row per deployment.
    const again = await op('keys/instances', {});
    expect(again.json.signingKey).toBe(instances.json.signingKey);
    const status = await op('keys/status', { tenantId, subject: owner, sessionId: ownerSessionId });
    expect(status.json.enrolled).toBe(true);
    expect(status.json.legacy).toBe(false);
    expect(status.json.sessionInstances).toEqual([instance.id]);
    expect(status.json.thisSessionInstances).toEqual([instance.id]);
    expect(status.json.automationInstances).toEqual([instance.id]);
    expect(typeof status.json.wrappedAutomationKey).toBe('string');
    expect(JSON.stringify(status.json)).not.toContain('"privateKey"');

    const nobody = await op('keys/status', { tenantId, subject: 'nobody@example.com' });
    expect(nobody.json.enrolled).toBe(false);
    expect(nobody.json.legacy).toBe(false);

    expect((await op('keys/revoke-automation', { tenantId, subject: owner })).json.revoked).toBe(1);
    const revoked = await op('keys/status', { tenantId, subject: owner });
    expect(revoked.json.automationInstances).toEqual([]);
    expect(revoked.json.automationUntil).toBeNull();

    // A delegation for an instance nobody runs is dropped; a malformed one is refused.
    const stale = await op('keys/delegate', {
      tenantId,
      subject: owner,
      sessionId: ownerSessionId,
      session: [{ instanceId: randomUUID(), sealedKey: 'sbox1:x:y' }],
      automation: [],
    });
    expect(stale.status).toBe(200);
    const bad = await op('keys/delegate', {
      tenantId,
      subject: owner,
      sessionId: ownerSessionId,
      session: [{ instanceId: instance.id, sealedKey: 'sbox1:not:real' }],
      automation: [],
    });
    expect(bad.status).toBe(400);
    expect(errorType(bad.json)).toBe('BAD_DELEGATION');
    // The stale call replaced this session's delegations with none: nothing opens for the owner now.
    const closed = await op('resource-key/ensure', {
      tenantId,
      kind: 'chat',
      resourceId: randomUUID(),
      ownerSubject: owner,
    });
    expect(closed.status).toBe(423);
    expect(errorType(closed.json)).toBe('NEEDS_DELEGATION');
    const census = await op('keys/census', { tenantId });
    expect(census.json).toEqual({ held: 2, managed: 0, own: 0 });

    // The browser seals again, and the owner is back for the tests below.
    if (!ownerKeys) throw new Error('owner not enrolled');
    const sealed = sealDelegations(ownerKeys, {
      instances: [{ id: instance.id, publicKey: instance.pair.publicKey }],
    });

    // A session cookie alone cannot replace the automation rows: without the
    // session blob they are refused, and an automation blob of some other
    // key is refused even beside a valid session blob. Nothing changed.
    const cookieOnly = await op('keys/delegate', {
      tenantId,
      subject: owner,
      sessionId: ownerSessionId,
      session: [{ instanceId: randomUUID(), sealedKey: 'sbox1:x:y' }],
      automation: sealed.automation,
    });
    expect(cookieOnly.status).toBe(423);
    expect(errorType(cookieOnly.json)).toBe('NEEDS_SESSION');
    const forgedAutomation = sealDelegations(
      { ...ownerKeys, automationKey: randomBytes(32) },
      { instances: [{ id: instance.id, publicKey: instance.pair.publicKey }] }
    );
    const forged = await op('keys/delegate', {
      tenantId,
      subject: owner,
      sessionId: ownerSessionId,
      session: sealed.session,
      automation: forgedAutomation.automation,
    });
    expect(forged.status).toBe(400);
    expect(errorType(forged.json)).toBe('BAD_DELEGATION');
    expect(
      (await op('keys/status', { tenantId, subject: owner })).json.automationInstances
    ).toEqual([]);
    // An empty session list stores nothing and drops this session's rows only on request.
    const empty = await op('keys/delegate', {
      tenantId,
      subject: owner,
      sessionId: ownerSessionId,
      session: [],
      automation: [],
    });
    expect(empty.status).toBe(400);
    expect(errorType(empty.json)).toBe('BAD_DELEGATION');
    expect(
      (
        await op('keys/delegate', {
          tenantId,
          subject: owner,
          sessionId: ownerSessionId,
          session: [],
          automation: [],
          revokeSession: true,
        })
      ).status
    ).toBe(200);

    const restored = await op('keys/delegate', {
      tenantId,
      subject: owner,
      sessionId: ownerSessionId,
      session: sealed.session,
      automation: sealed.automation,
    });
    expect(restored.status).toBe(200);
    expect((await op('keys/status', { tenantId, subject: owner })).json.sessionInstances).toEqual([
      instance.id,
    ]);
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

    // A caller's cookie, host and framing headers never reach the provider;
    // fetch is never allowed to follow a redirect on its own.
    const stripped = await fetch(`${base}/v1/api`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'x-delegate-grant': JSON.stringify(grant),
        'x-delegate-url': 'https://api.github.com/user',
        'x-delegate-method': 'GET',
        'x-delegate-headers': JSON.stringify({
          cookie: 'session=stolen',
          host: 'evil.example.com',
          'content-length': '999',
          connection: 'close',
          'x-fine': 'yes',
        }),
      },
    });
    expect(stripped.status).toBe(200);
    const strippedCall = upstreamCalls.at(-1);
    expect(strippedCall?.redirect).toBe('manual');
    expect(strippedCall?.headers['x-fine']).toBe('yes');
    for (const name of ['cookie', 'host', 'content-length', 'connection']) {
      expect(strippedCall?.headers[name]).toBeUndefined();
    }

    // A redirect to the provider's own host is followed with the token; one
    // to anywhere else is handed back as the 3xx it is, and never dialed.
    scriptedAnswers.push(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/elsewhere' },
        })
    );
    const followed = await fetch(`${base}/v1/api`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'x-delegate-grant': JSON.stringify(grant),
        'x-delegate-url': 'https://api.github.com/redirecting',
        'x-delegate-method': 'POST',
      },
      body: '{"name":"x"}',
    });
    expect(followed.status).toBe(200);
    expect(await followed.json()).toEqual({ hello: 'world' });
    const hop = upstreamCalls.at(-1);
    expect(hop?.url).toBe('https://github.com/elsewhere');
    expect(hop?.authorization).toBe('Bearer gho_secret');
    // 302 on a POST becomes a GET without a body, the way fetch would.
    expect(hop?.method).toBe('GET');
    expect(hop?.body).toBe('');

    const dialedBefore = upstreamCalls.length;
    scriptedAnswers.push(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.com/steal' },
        })
    );
    const offsite = await fetch(`${base}/v1/api`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'x-delegate-grant': JSON.stringify(grant),
        'x-delegate-url': 'https://api.github.com/redirecting',
        'x-delegate-method': 'GET',
      },
      redirect: 'manual',
    });
    expect(offsite.status).toBe(302);
    expect(offsite.headers.get('location')).toBe('https://evil.example.com/steal');
    expect(upstreamCalls.length).toBe(dialedBefore + 1);
    expect(upstreamCalls.some((call) => new URL(call.url).hostname === 'evil.example.com')).toBe(
      false
    );

    // The chain stops after five hops, whichever host they stay on.
    for (let i = 0; i < 7; i += 1) {
      scriptedAnswers.push(
        () =>
          new Response(null, {
            status: 307,
            headers: { location: `https://api.github.com/hop/${i}` },
          })
      );
    }
    const dialedBeforeChain = upstreamCalls.length;
    const chain = await fetch(`${base}/v1/api`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'x-delegate-grant': JSON.stringify(grant),
        'x-delegate-url': 'https://api.github.com/redirecting',
        'x-delegate-method': 'GET',
      },
      redirect: 'manual',
    });
    expect(chain.status).toBe(307);
    expect(upstreamCalls.length).toBe(dialedBeforeChain + 6);
    scriptedAnswers.length = 0;

    const described = await op('grant/describe', grant);
    expect(described.json.accountId).toBe(accountId);
    expect(JSON.stringify(described.json)).not.toContain('gho_secret');

    expect((await op('grant/delete', { tenantId, provider: GITHUB, accountId })).status).toBe(200);
    expect((await op('grant/describe', grant)).status).toBe(404);
  });

  it('relays a workspace git exchange on a ticket with the token attached, and never a write on a read ticket', async () => {
    const accountId = `gh-${randomUUID().slice(0, 8)}`;
    const saved = await setGrant(GITHUB, tenantId, {
      accountId,
      clientId: 'client',
      displayName: 'Octo',
      accessToken: 'gho_git_secret',
      refreshToken: 'ghr_secret',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      requestedScopes: ['repo'],
      grantedScopes: null,
      metadata: { login: 'octo' },
      subject: owner,
    });
    expect(saved.ok).toBe(true);

    // Nobody but GitHub and Bitbucket; nobody without a grant.
    expect(
      errorType(
        (await op('grant/git-ticket', { tenantId, provider: 'webex', subject: owner })).json
      )
    ).toBe('host_not_allowed');
    expect(
      (await op('grant/git-ticket', { tenantId, provider: GITHUB, subject: friend })).status
    ).toBe(404);

    const read = await op('grant/git-ticket', { tenantId, provider: GITHUB, subject: owner });
    expect(read.status).toBe(200);
    expect(read.json.host).toBe('github.com');
    expect(read.json.insteadOf).toBe('https://github.com/');
    const ticket = typeof read.json.ticket === 'string' ? read.json.ticket : '';
    expect(ticket).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{48}$/);
    expect(JSON.stringify(read.json)).not.toContain('gho_git_secret');

    // The route takes no bearer key: the ticket is the credential.
    const refs = await fetch(
      `${base}/git/${ticket}/github.com/acme/demo.git/info/refs?service=git-upload-pack`,
      { headers: { 'git-protocol': 'version=2', authorization: 'Basic forged' } }
    );
    expect(refs.status).toBe(200);
    expect(refs.headers.get('x-git-upstream')).toBe('yes');
    expect(await refs.text()).toContain('# service=git-upload-pack');
    const advertised = gitCalls.at(-1);
    expect(advertised?.url).toBe(
      'https://github.com/acme/demo.git/info/refs?service=git-upload-pack'
    );
    expect(advertised?.method).toBe('GET');
    expect(advertised?.headers.authorization).toBe(
      `Basic ${Buffer.from('x-access-token:gho_git_secret').toString('base64')}`
    );
    expect(advertised?.headers['git-protocol']).toBe('version=2');
    expect(advertised?.headers.host).toBeUndefined();

    const fetchPack = await fetch(
      `${base}/git/${ticket}/github.com/acme/demo.git/git-upload-pack`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-upload-pack-request' },
        body: '0032want deadbeef',
      }
    );
    expect(fetchPack.status).toBe(200);
    expect(gitCalls.at(-1)?.body).toBe('0032want deadbeef');

    // A read ticket stops at receive-pack, before anything is dialed.
    const dialed = gitCalls.length;
    const pushRefs = await fetch(
      `${base}/git/${ticket}/github.com/acme/demo.git/info/refs?service=git-receive-pack`
    );
    expect(pushRefs.status).toBe(403);
    const push = await fetch(`${base}/git/${ticket}/github.com/acme/demo.git/git-receive-pack`, {
      method: 'POST',
      body: '0000',
    });
    expect(push.status).toBe(403);
    expect(errorType(Object(await push.json()))).toBe('read_only_ticket');
    expect(gitCalls.length).toBe(dialed);

    // The ticket is good for its host, nothing else, and not for a guessed secret.
    expect(
      (
        await fetch(
          `${base}/git/${ticket}/bitbucket.org/acme/demo.git/info/refs?service=git-upload-pack`
        )
      ).status
    ).toBe(404);
    const [id] = ticket.split('.');
    expect(
      (
        await fetch(
          `${base}/git/${id}.${'0'.repeat(48)}/github.com/acme/demo.git/info/refs?service=git-upload-pack`
        )
      ).status
    ).toBe(404);
    expect((await fetch(`${base}/git/${ticket}/github.com/acme/demo.git/HEAD`)).status).toBe(404);
    expect(gitCalls.length).toBe(dialed);

    // A write ticket pushes.
    const write = await op('grant/git-ticket', {
      tenantId,
      provider: GITHUB,
      subject: owner,
      write: true,
    });
    const writeTicket = typeof write.json.ticket === 'string' ? write.json.ticket : '';
    const pushed = await fetch(
      `${base}/git/${writeTicket}/github.com/acme/demo.git/git-receive-pack`,
      { method: 'POST', body: '0000' }
    );
    expect(pushed.status).toBe(200);
    expect(gitCalls.at(-1)?.url).toBe('https://github.com/acme/demo.git/git-receive-pack');

    expect((await op('grant/delete', { tenantId, provider: GITHUB, accountId })).status).toBe(200);
  });

  it("forwards a Mirth op to its worker with the person's credential attached, never a stored one", async () => {
    process.env.MIRTH_WORKER_URL = 'http://mirth.test';
    process.env.MIRTH_WORKER_API_KEY = 'mirth-worker-key';
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const db = dbResult.val;
    const instance = await createInstance(db, tenantId, {
      name: 'Dev',
      environment: 'dev',
      baseUrl: 'https://mirth.example.com',
      tlsVerify: true,
      caPem: null,
      allowInsecureHttp: false,
      enabled: true,
    });
    if (!instance.ok) throw new Error('instance not created');
    const sealed = await sealForSubject(
      db,
      tenantId,
      owner,
      JSON.stringify({ username: 'alice', password: 'pw-secret' })
    );
    if (!sealed.ok) throw new Error('credential not sealed');
    const stored = await upsertConnection(db, tenantId, instance.val, owner, {
      encryptedCredentials: sealed.val,
      username: 'alice',
      permissions: ['channels.read'],
    });
    if (!stored.ok) throw new Error('connection not stored');

    const forwarded = await op('forward/mirth/api', {
      tenantId,
      instanceId: instance.val,
      subject: owner,
      method: 'GET',
      path: '/channels/statuses',
      credentials: { username: 'forged', password: 'forged' },
    });
    expect(forwarded.status).toBe(200);
    expect(forwarded.json).toEqual({ hello: 'world' });
    const call = upstreamCalls.at(-1);
    expect(call?.url).toBe('http://mirth.test/v1/api');
    expect(call?.authorization).toBe('Bearer mirth-worker-key');
    const sent: unknown = JSON.parse(call?.body ?? '{}');
    expect(isRecord(sent) ? sent.credentials : null).toEqual({
      username: 'alice',
      password: 'pw-secret',
    });
    expect(isRecord(sent) ? sent.subject : null).toBe(owner);

    // Somebody else: the connection is not theirs.
    const stranger = await op('forward/mirth/api', {
      tenantId,
      instanceId: instance.val,
      subject: friend,
      method: 'GET',
      path: '/channels/statuses',
    });
    expect(stranger.status).toBe(403);
    expect(errorType(stranger.json)).toBe('not_connected');

    // A pass-through op carries no credential and reaches the worker as sent.
    const probe = await op('forward/mirth/probe', { tenantId, instanceId: instance.val });
    expect(probe.status).toBe(200);
    expect(upstreamCalls.at(-1)?.url).toBe('http://mirth.test/v1/probe');

    expect((await op('forward/mirth/nope', {})).status).toBe(404);
    expect((await op('forward/elsewhere/api', {})).status).toBe(404);

    await db.deleteFrom('mirth_instances').where('tenant_id', '=', tenantId).execute();
  });
});

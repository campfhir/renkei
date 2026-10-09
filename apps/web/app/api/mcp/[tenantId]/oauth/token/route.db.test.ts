/**
 * Refresh-token rotation against a real database (skipped without
 * DATABASE_URL): every refresh returns a new refresh token and retires the
 * presented one; a retired token presented again revokes its whole family
 * and the subject's access tokens; the refreshed token takes the roles of
 * the subject's newest live browser session; and rotation never extends the
 * family's lifetime. The row lock and the transaction are the reason this
 * runs against Postgres rather than a stub.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { NextRequest } from 'next/server';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { hashToken } from '@/lib/mcp-token';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { POST } from './route';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('refresh-token rotation', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const clientId = `client_${tenantId.slice(0, 8)}`;
  const clientSecret = 'client-secret-for-tests';
  const subject = `person-${tenantId.slice(0, 8)}@example.com`;

  async function issueRefreshToken(options: { familyId?: string; roles?: string[] } = {}) {
    const token = `rt_${randomUUID()}`;
    const familyId = options.familyId ?? randomUUID();
    await db
      .insertInto('oauth_refresh_tokens')
      .values({
        token_id: randomUUID(),
        client_id: clientId,
        subject,
        scope: 'openid',
        roles: options.roles ?? ['renkei-user'],
        token_hash: hashToken(token),
        family_id: familyId,
        expires_at: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      })
      .execute();
    return { token, familyId };
  }

  async function refresh(token: string) {
    resetInboundLimits();
    const request = new NextRequest(`http://localhost/api/mcp/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const response = await POST(request, { params: Promise.resolve({ tenantId }) });
    return { status: response.status, body: await response.json() };
  }

  const liveRefreshTokens = () =>
    db
      .selectFrom('oauth_refresh_tokens')
      .select(['token_hash', 'rotated_at', 'family_id', 'roles', 'expires_at'])
      .execute();

  const accessTokens = () =>
    db
      .selectFrom('oauth_access_tokens')
      .select(['token_hash', 'roles'])
      .where('subject', '=', subject)
      .execute();

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `rot-${tenantId.slice(0, 8)}`, domain_verified_at: new Date() })
      .execute();
    await db
      .insertInto('oauth_clients')
      .values({
        client_id: clientId,
        client_name: 'rotation test',
        client_secret_hash: hashToken(clientSecret),
        redirect_uris: ['https://client.example/cb'],
      })
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('sessions').execute();
    await db.deleteFrom('oauth_access_tokens').execute();
    await db.deleteFrom('oauth_refresh_tokens').execute();
    await db.deleteFrom('oauth_clients').execute();
    await db.deleteFrom('tenant_settings').execute();
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  beforeEach(async () => {
    await db.deleteFrom('sessions').execute();
    await db.deleteFrom('oauth_access_tokens').execute();
    await db.deleteFrom('oauth_refresh_tokens').execute();
  });

  it('rotates: a new refresh token in the same family, the old one retired, lifetime unchanged', async () => {
    const { token, familyId } = await issueRefreshToken();
    const before = (await liveRefreshTokens())[0];

    const first = await refresh(token);

    expect(first.status).toBe(200);
    expect(typeof first.body.refresh_token).toBe('string');
    expect(first.body.refresh_token).not.toBe(token);
    expect(typeof first.body.access_token).toBe('string');

    const rows = await liveRefreshTokens();
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.token_hash === hashToken(token));
    const next = rows.find((r) => r.token_hash === hashToken(first.body.refresh_token));
    expect(old?.rotated_at).not.toBeNull();
    expect(next?.rotated_at).toBeNull();
    expect(next?.family_id).toBe(familyId);
    expect(new Date(String(next?.expires_at)).getTime()).toBe(
      new Date(String(before.expires_at)).getTime()
    );

    // The successor refreshes in turn.
    const second = await refresh(first.body.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
  });

  it("revokes the whole family and the subject's access tokens when a rotated token is reused", async () => {
    const { token, familyId } = await issueRefreshToken();
    // An unrelated family for the same subject and client stays untouched.
    const other = await issueRefreshToken();

    const first = await refresh(token);
    expect(first.status).toBe(200);
    expect(await accessTokens()).toHaveLength(1);

    const replay = await refresh(token);

    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(replay.body.error_description).toMatch(/reuse/i);
    const rows = await liveRefreshTokens();
    expect(rows.filter((r) => r.family_id === familyId)).toHaveLength(0);
    expect(rows.filter((r) => r.family_id === other.familyId)).toHaveLength(1);
    expect(await accessTokens()).toHaveLength(0);

    // The successor died with its family.
    const successor = await refresh(first.body.refresh_token);
    expect(successor.status).toBe(400);
    expect(successor.body.error_description).toBe('Refresh token not found');
  });

  it("re-derives roles from the subject's newest live browser session", async () => {
    const { token } = await issueRefreshToken({ roles: ['renkei-user', 'renkei-operator'] });
    // The person signed in again since; the IdP no longer asserts operator.
    await db
      .insertInto('sessions')
      .values({
        id: randomUUID(),
        subject,
        roles: ['renkei-user'],
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      })
      .execute();

    const result = await refresh(token);

    expect(result.status).toBe(200);
    const [access] = await accessTokens();
    expect(access.roles).toEqual(['renkei-user']);
    const next = (await liveRefreshTokens()).find((r) => r.rotated_at === null);
    expect(next?.roles).toEqual(['renkei-user']);
  });

  it('keeps the frozen roles when the subject holds no live session', async () => {
    const { token } = await issueRefreshToken({ roles: ['renkei-user', 'renkei-operator'] });
    // An expired session does not count.
    await db
      .insertInto('sessions')
      .values({
        id: randomUUID(),
        subject,
        roles: ['renkei-user'],
        expires_at: new Date(Date.now() - 1000),
      })
      .execute();

    const result = await refresh(token);

    expect(result.status).toBe(200);
    const [access] = await accessTokens();
    expect(access.roles).toEqual(['renkei-user', 'renkei-operator']);
  });
});

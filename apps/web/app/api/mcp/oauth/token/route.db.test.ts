/**
 * Refresh-token rotation against a real database (skipped without
 * DATABASE_URL): every refresh returns a new refresh token and retires the
 * presented one; a retired token presented again revokes its whole family
 * and the subject's access tokens; the refreshed token takes the roles of
 * the subject's newest live browser session; and rotation never extends the
 * family's lifetime. The row lock and the transaction are the reason this
 * runs against Postgres rather than a stub. Every check is on what a
 * client can see: which tokens the endpoint still honours, and the roles
 * an issued access token carries.
 */

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { closeDataStore, getDataStore } from '@renkei/db';
import { hashToken } from '@/lib/mcp-token';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { POST } from './route';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('refresh-token rotation', () => {
  const suiteId = randomUUID();
  const clientId = `client_${suiteId.slice(0, 8)}`;
  const clientSecret = 'client-secret-for-tests';
  const subject = `person-${suiteId.slice(0, 8)}@example.com`;

  /** A refresh token as the code exchange issues one (its own family). */
  async function issueRefreshToken(
    options: { roles?: string[]; expiresAt?: Date } = {}
  ): Promise<{ token: string }> {
    const token = `rt_${randomUUID()}`;
    await getDataStore().oauthTokens.insertRefreshToken({
      tokenId: randomUUID(),
      clientId,
      subject,
      scope: 'openid',
      roles: options.roles ?? ['renkei-user'],
      tokenHash: hashToken(token),
      expiresAt: options.expiresAt ?? new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });
    return { token };
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
    const response = await POST(request);
    return { status: response.status, body: await response.json() };
  }

  /** The access token the endpoint issued, as the MCP routes look it up; null once revoked. */
  const accessToken = (token: string) =>
    getDataStore().oauthTokens.findAccessToken(hashToken(token), 'jira');

  const signIn = (expiresAt: Date) =>
    getDataStore().sessions.create({
      id: randomUUID(),
      subject,
      roles: ['renkei-user'],
      expiresAt,
    });

  beforeAll(async () => {
    await getDataStore().oauthConsents.registerClient({
      clientId,
      clientSecretHash: hashToken(clientSecret),
      clientName: 'rotation test',
      redirectUris: ['https://client.example/cb'],
      responseTypes: ['code'],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
  });

  // Signing the person out everywhere ends their sessions and every token.
  beforeEach(async () => {
    await getDataStore().sessions.revokeAll(subject);
  });

  afterAll(async () => {
    await getDataStore().sessions.revokeAll(subject);
    await closeDataStore();
  });

  it('rotates: a new refresh token, the old one retired, lifetime unchanged', async () => {
    // A family close to the end of its life: rotation must not extend it.
    const lifetimeMs = 2_000;
    const expiresAt = new Date(Date.now() + lifetimeMs);
    const { token } = await issueRefreshToken({ expiresAt });

    const first = await refresh(token);

    expect(first.status).toBe(200);
    expect(typeof first.body.refresh_token).toBe('string');
    expect(first.body.refresh_token).not.toBe(token);
    expect(typeof first.body.access_token).toBe('string');
    expect(await accessToken(first.body.access_token)).not.toBeNull();

    // The successor refreshes in turn.
    const second = await refresh(first.body.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);

    // Past the family's original end, its newest token is expired too.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now()) + 100)
    );
    const late = await refresh(second.body.refresh_token);
    expect(late.status).toBe(400);
    expect(late.body.error_description).toBe('Refresh token expired');
  });

  it("revokes the whole family and the subject's access tokens when a rotated token is reused", async () => {
    const { token } = await issueRefreshToken();
    // An unrelated family for the same subject and client stays untouched.
    const other = await issueRefreshToken();

    const first = await refresh(token);
    expect(first.status).toBe(200);
    expect(await accessToken(first.body.access_token)).not.toBeNull();

    const replay = await refresh(token);

    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(replay.body.error_description).toMatch(/reuse/i);
    expect(await accessToken(first.body.access_token)).toBeNull();

    // The successor died with its family.
    const successor = await refresh(first.body.refresh_token);
    expect(successor.status).toBe(400);
    expect(successor.body.error_description).toBe('Refresh token not found');

    // The other family still refreshes.
    expect((await refresh(other.token)).status).toBe(200);
  });

  it("re-derives roles from the subject's newest live browser session", async () => {
    const { token } = await issueRefreshToken({ roles: ['renkei-user', 'renkei-operator'] });
    // The person signed in again since; the IdP no longer asserts operator.
    await signIn(new Date(Date.now() + 60 * 60 * 1000));

    const result = await refresh(token);

    expect(result.status).toBe(200);
    expect((await accessToken(result.body.access_token))?.roles).toEqual(['renkei-user']);

    // The successor carries the re-derived roles forward: with no session
    // left to re-derive from, its own roles are what the next token gets.
    await getDataStore().sessions.deleteForSubject(subject);
    const next = await refresh(result.body.refresh_token);
    expect(next.status).toBe(200);
    expect((await accessToken(next.body.access_token))?.roles).toEqual(['renkei-user']);
  });

  it('keeps the frozen roles, minus the operator role, when the subject holds no live session', async () => {
    const { token } = await issueRefreshToken({ roles: ['renkei-user', 'renkei-operator'] });
    // An expired session does not count.
    await signIn(new Date(Date.now() - 1000));

    const result = await refresh(token);

    expect(result.status).toBe(200);
    // The operator role was frozen at consent and the identity provider has
    // not been asked since: it comes back with the next sign-in.
    expect((await accessToken(result.body.access_token))?.roles).toEqual(['renkei-user']);
  });
});

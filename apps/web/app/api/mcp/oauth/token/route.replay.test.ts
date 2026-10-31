/**
 * An authorization code is spent atomically: of two concurrent redemptions
 * one is issued tokens, the other is refused and the tokens the first was
 * just given are revoked.
 */

import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { hashToken } from '@/lib/mcp-token';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { POST } from './route';

jest.mock('@renkei/settings', () => ({
  getOrgSettings: jest.fn().mockResolvedValue({
    ok: true,
    val: { accessTokenTtlMinutes: 60, refreshTokenTtlDays: 30 },
  }),
}));

const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const redirectUri = 'http://127.0.0.1:3000/cb';

function tokenRequest(params: Record<string, string>): Promise<Response> {
  resetInboundLimits();
  return POST(
    new NextRequest('http://localhost/api/mcp/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'cli',
        client_secret: 'secret',
        ...params,
      }).toString(),
    })
  );
}

afterEach(() => resetDataStore());

it('issues to one of two concurrent redemptions and revokes after the replay', async () => {
  const store = createMemoryDataStore();
  registerDataStore(store);
  await store.oauthConsents.registerClient({
    clientId: 'cli',
    clientSecretHash: hashToken('secret'),
    clientName: 'Cli',
    redirectUris: [redirectUri],
    responseTypes: ['code'],
    grantTypes: ['authorization_code'],
  });
  await store.oauthConsents.insertAuthorizationCode({
    code: 'code-1',
    clientId: 'cli',
    subject: 'ann',
    scope: 'openid',
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    roles: ['renkei-user'],
    expiresAt: new Date(Date.now() + 60_000),
  });

  const redeem = () =>
    tokenRequest({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
  const [a, b] = await Promise.all([redeem(), redeem()]);
  expect([a.status, b.status].sort()).toEqual([200, 400]);
  const issued = await (a.status === 200 ? a : b).json();
  const refused = await (a.status === 200 ? b : a).json();
  expect(refused).toMatchObject({ error: 'invalid_grant' });

  // Whatever the winner was given went with the replay.
  const refresh = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: issued.refresh_token,
  });
  expect(refresh.status).toBe(400);
});

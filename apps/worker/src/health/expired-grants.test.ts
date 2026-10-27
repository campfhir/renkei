/**
 * The expired-grant sweep against a real database (skipped without
 * DATABASE_URL): a grant months past expiry is deleted, a merely-expired
 * one — the normal state between refreshes — is never touched.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { sweepExpiredGrants, GRANT_STALE_DAYS } from './expired-grants';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('sweepExpiredGrants', () => {
  const staleAccount = `stale-${randomUUID().slice(0, 8)}`;
  const freshAccount = `fresh-${randomUUID().slice(0, 8)}`;

  /** A connect's write: the tokens arrive sealed (opaque here, never opened). */
  async function connect(accountId: string, expiresAt: Date): Promise<void> {
    await getDataStore().providerGrants.upsertSealed('atlassian', {
      accountId,
      clientId: 'client-1',
      displayName: 'Test User',
      subject: `grant-owner-${accountId}`,
      encryptedAccessToken: 'v1.a.b.c',
      encryptedRefreshToken: 'v1.a.b.c',
      keepStoredRefreshToken: false,
      expiresAt,
      requestedScopes: [],
      grantedScopes: null,
      metadata: {},
    });
  }

  beforeAll(async () => {
    const staleMs = (GRANT_STALE_DAYS + 1) * 24 * 60 * 60_000;
    await connect(staleAccount, new Date(Date.now() - staleMs));
    // Expired an hour ago — the everyday state of a healthy grant between
    // uses; deleting it would destroy a working refresh token.
    await connect(freshAccount, new Date(Date.now() - 60 * 60_000));
  });

  afterAll(async () => {
    await getDataStore().providerGrants.delete('atlassian', freshAccount);
  });

  it('deletes abandoned grants and spares recently-expired ones', async () => {
    await sweepExpiredGrants();

    const grants = getDataStore().providerGrants;
    expect(await grants.find('atlassian', staleAccount)).toBeNull();
    expect(await grants.find('atlassian', freshAccount)).not.toBeNull();
  });
});

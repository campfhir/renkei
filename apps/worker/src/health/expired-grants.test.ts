/**
 * The expired-grant sweep against a real database (skipped without
 * DATABASE_URL): a grant months past expiry is deleted, a merely-expired
 * one — the normal state between refreshes — is never touched.
 */

import { randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import type { Kysely } from 'kysely';
import { sweepExpiredGrants, GRANT_STALE_DAYS } from './expired-grants';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('sweepExpiredGrants', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const staleAccount = `stale-${randomUUID().slice(0, 8)}`;
  const freshAccount = `fresh-${randomUUID().slice(0, 8)}`;

  function grantRow(accountId: string, expiresAt: Date) {
    return {
      tenant_id: tenantId,
      provider: 'atlassian',
      provider_account_id: accountId,
      client_id: 'client-1',
      display_name: 'Test User',
      encrypted_access_token: 'v1.a.b.c',
      encrypted_refresh_token: 'v1.a.b.c',
      expires_at: expiresAt,
    };
  }

  beforeAll(async () => {
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('no database');
    db = dbResult.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `gs-${tenantId.slice(0, 8)}` })
      .execute();
    const staleMs = (GRANT_STALE_DAYS + 1) * 24 * 60 * 60_000;
    await db
      .insertInto('provider_grants')
      .values([
        grantRow(staleAccount, new Date(Date.now() - staleMs)),
        // Expired an hour ago — the everyday state of a healthy grant
        // between uses; deleting it would destroy a working refresh token.
        grantRow(freshAccount, new Date(Date.now() - 60 * 60_000)),
      ])
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  it('deletes abandoned grants and spares recently-expired ones', async () => {
    await sweepExpiredGrants();

    const remaining = await db
      .selectFrom('provider_grants')
      .select('provider_account_id')
      .where('tenant_id', '=', tenantId)
      .execute();
    const accounts = remaining.map((row) => row.provider_account_id);
    expect(accounts).not.toContain(staleAccount);
    expect(accounts).toContain(freshAccount);
  });
});

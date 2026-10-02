/**
 * The grant store against a real database (skipped without DATABASE_URL):
 * a grant with an owner is sealed under THEIR key, not the deployment key
 * the caller passes; a grant without one, and a row written before
 * per-user keys, still open under that deployment key.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase } from '@renkei/db';
import { decrypt, encrypt, isUserSealed } from '@renkei/crypto';
import { getGrant, setGrant } from './store';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('provider grant store under per-user keys', () => {
  const tenantId = randomUUID();
  const subject = `owner-${tenantId.slice(0, 8)}`;
  const legacyKey = randomBytes(32);
  const base = {
    clientId: 'client-1',
    displayName: 'Alice',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    requestedScopes: ['read:jira-work'],
    grantedScopes: ['read:jira-work'],
    metadata: { cloudId: 'cloud-1' },
  };

  beforeAll(async () => {
    process.env.USER_KEY_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    await result.val
      .insertInto('tenants')
      .values({ id: tenantId, slug: `grants-${tenantId.slice(0, 8)}` })
      .execute();
  });

  afterAll(async () => {
    const result = getDatabase();
    if (result.ok) await result.val.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  it('seals an owned grant under the owner’s key and opens it back', async () => {
    const set = await setGrant(
      'atlassian',
      tenantId,
      { ...base, accountId: 'acct-1', subject, accessToken: 'access-1', refreshToken: 'refresh-1' },
      legacyKey
    );
    expect(set.ok).toBe(true);
    const db = getDatabase();
    if (!db.ok) throw new Error('db');
    const row = await db.val
      .selectFrom('provider_grants')
      .select(['encrypted_access_token', 'encrypted_refresh_token'])
      .where('tenant_id', '=', tenantId)
      .where('provider_account_id', '=', 'acct-1')
      .executeTakeFirstOrThrow();
    expect(isUserSealed(row.encrypted_access_token)).toBe(true);
    expect(isUserSealed(row.encrypted_refresh_token)).toBe(true);
    // Not the deployment key: that key opens nothing here.
    expect(decrypt(row.encrypted_access_token.slice('uenc1:'.length), legacyKey).ok).toBe(false);

    const got = await getGrant('atlassian', tenantId, 'acct-1', legacyKey);
    expect(got.ok && got.val?.accessToken).toBe('access-1');
    expect(got.ok && got.val?.refreshToken).toBe('refresh-1');
  });

  it('a reconnect with an empty refresh token keeps the stored one, re-sealed or not', async () => {
    const set = await setGrant(
      'atlassian',
      tenantId,
      { ...base, accountId: 'acct-1', subject, accessToken: 'access-2', refreshToken: '' },
      legacyKey
    );
    expect(set.ok).toBe(true);
    const got = await getGrant('atlassian', tenantId, 'acct-1', legacyKey);
    expect(got.ok && got.val?.accessToken).toBe('access-2');
    expect(got.ok && got.val?.refreshToken).toBe('refresh-1');
  });

  it('a grant with no owner stays under the deployment key', async () => {
    await setGrant(
      'atlassian',
      tenantId,
      { ...base, accountId: 'acct-2', subject: null, accessToken: 'a', refreshToken: 'r' },
      legacyKey
    );
    const db = getDatabase();
    if (!db.ok) throw new Error('db');
    const row = await db.val
      .selectFrom('provider_grants')
      .select('encrypted_access_token')
      .where('tenant_id', '=', tenantId)
      .where('provider_account_id', '=', 'acct-2')
      .executeTakeFirstOrThrow();
    expect(isUserSealed(row.encrypted_access_token)).toBe(false);
    expect(decrypt(row.encrypted_access_token, legacyKey)).toMatchObject({ ok: true, val: 'a' });
    const got = await getGrant('atlassian', tenantId, 'acct-2', legacyKey);
    expect(got.ok && got.val?.accessToken).toBe('a');
  });

  it('a row written before per-user keys opens under the deployment key', async () => {
    const db = getDatabase();
    if (!db.ok) throw new Error('db');
    await db.val
      .updateTable('provider_grants')
      .set({
        encrypted_access_token: encrypt('legacy-access', legacyKey),
        encrypted_refresh_token: encrypt('legacy-refresh', legacyKey),
      })
      .where('tenant_id', '=', tenantId)
      .where('provider_account_id', '=', 'acct-1')
      .execute();
    const got = await getGrant('atlassian', tenantId, 'acct-1', legacyKey);
    expect(got.ok && got.val?.accessToken).toBe('legacy-access');
    expect(got.ok && got.val?.refreshToken).toBe('legacy-refresh');
  });
});

/**
 * The grant store against a real database (skipped without DATABASE_URL):
 * a grant is sealed under its OWNER's key and under nothing else — a row
 * under the old deployment key, or one with no owner at all, does not
 * open.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase } from '@renkei/db';
import { decrypt, encrypt, isUserSealed } from '@renkei/crypto';
import { setKeyVault } from '@renkei/user-keys';
import { enrollTestPerson, registerTestInstance } from '@renkei/user-keys/test-support';
import { sql } from 'kysely';
import { getGrant, setGrant } from './store';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('provider grant store under per-user keys', () => {
  const suiteId = randomUUID();
  const subject = `owner-${suiteId.slice(0, 8)}`;
  const legacyKey = randomBytes(32);
  const base = {
    clientId: 'client-1',
    displayName: 'Alice',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    requestedScopes: ['read:jira-work'],
    grantedScopes: ['read:jira-work'],
    metadata: { cloudId: 'cloud-1' },
  };

  let instanceId = '';

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    // The owner holds a key, as their browser would have enrolled them, with
    // a session delegation to this test's own delegate instance.
    const instance = await registerTestInstance(result.val);
    instanceId = instance.id;
    await enrollTestPerson(result.val, {
      subject,
      instances: [{ id: instance.id, publicKey: instance.pair.publicKey }],
    });
  });

  afterAll(async () => {
    setKeyVault(null);
    const result = getDatabase();
    if (result.ok) {
      await result.val.deleteFrom('delegate_instances').where('id', '=', instanceId).execute();
    }
    await closeDatabase();
  });

  it('seals an owned grant under the owner’s key and opens it back', async () => {
    const set = await setGrant('atlassian', {
      ...base,
      accountId: 'acct-1',
      subject,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
    expect(set.ok).toBe(true);
    const db = getDatabase();
    if (!db.ok) throw new Error('db');
    const row = await db.val
      .selectFrom('provider_grants')
      .select(['encrypted_access_token', 'encrypted_refresh_token'])
      .where('provider_account_id', '=', 'acct-1')
      .executeTakeFirstOrThrow();
    expect(isUserSealed(row.encrypted_access_token)).toBe(true);
    expect(isUserSealed(row.encrypted_refresh_token)).toBe(true);
    // Not the deployment key: that key opens nothing here.
    expect(decrypt(row.encrypted_access_token.slice('uenc1:'.length), legacyKey).ok).toBe(false);

    const got = await getGrant('atlassian', 'acct-1');
    expect(got.ok && got.val?.accessToken).toBe('access-1');
    expect(got.ok && got.val?.refreshToken).toBe('refresh-1');
  });

  it('a reconnect with an empty refresh token keeps the stored one, re-sealed or not', async () => {
    const set = await setGrant('atlassian', {
      ...base,
      accountId: 'acct-1',
      subject,
      accessToken: 'access-2',
      refreshToken: '',
    });
    expect(set.ok).toBe(true);
    const got = await getGrant('atlassian', 'acct-1');
    expect(got.ok && got.val?.accessToken).toBe('access-2');
    expect(got.ok && got.val?.refreshToken).toBe('refresh-1');
  });

  it('a row written under the old deployment key does not open', async () => {
    const db = getDatabase();
    if (!db.ok) throw new Error('db');
    await db.val
      .updateTable('provider_grants')
      .set({
        encrypted_access_token: encrypt('legacy-access', legacyKey),
        encrypted_refresh_token: encrypt('legacy-refresh', legacyKey),
      })
      .where('provider_account_id', '=', 'acct-1')
      .execute();
    const got = await getGrant('atlassian', 'acct-1');
    expect(!got.ok && got.err.type).toBe('DECRYPTION_ERROR');
  });

  it('a row with no owner has no key and does not open', async () => {
    const db = getDatabase();
    if (!db.ok) throw new Error('db');
    const set = await setGrant('atlassian', {
      ...base,
      accountId: 'acct-2',
      subject,
      accessToken: 'a',
      refreshToken: 'r',
    });
    expect(set.ok).toBe(true);
    await sql`UPDATE provider_grants SET subject = NULL WHERE provider_account_id = 'acct-2'`.execute(
      db.val
    );
    const got = await getGrant('atlassian', 'acct-2');
    expect(!got.ok && got.err.type).toBe('DECRYPTION_ERROR');
  });
});

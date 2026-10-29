/**
 * The grant store against a real database (skipped without DATABASE_URL):
 * a grant is sealed under its OWNER's key and under nothing else — a row
 * under the old deployment key, or one with no owner at all, does not
 * open.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeDataStore,
  createMemoryDataStore,
  getDataStore,
  registerDataStore,
  resetDataStore,
} from '@renkei/db';
import { decrypt, encrypt, isUserSealed } from '@renkei/crypto';
import { setKeyVault } from '@renkei/user-keys';
import { enrollTestPerson, registerTestInstance } from '@renkei/user-keys/test-support';
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

  const accountId = `acct-${suiteId.slice(0, 8)}`;
  let instanceId = '';

  beforeAll(async () => {
    // The owner holds a key, as their browser would have enrolled them, with
    // a session delegation to this test's own delegate instance.
    const instance = await registerTestInstance();
    instanceId = instance.id;
    await enrollTestPerson({
      subject,
      instances: [{ id: instance.id, publicKey: instance.pair.publicKey }],
    });
  });

  afterAll(async () => {
    setKeyVault(null);
    await getDataStore().userKeys.deleteInstance(instanceId);
    await closeDataStore();
  });

  it('seals an owned grant under the owner’s key and opens it back', async () => {
    const set = await setGrant('atlassian', {
      ...base,
      accountId,
      subject,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
    expect(set.ok).toBe(true);
    const row = await getDataStore().providerGrants.findSealed('atlassian', accountId);
    if (!row) throw new Error('grant not stored');
    expect(isUserSealed(row.encryptedAccessToken)).toBe(true);
    expect(isUserSealed(row.encryptedRefreshToken)).toBe(true);
    // Not the deployment key: that key opens nothing here.
    expect(decrypt(row.encryptedAccessToken.slice('uenc1:'.length), legacyKey).ok).toBe(false);

    const got = await getGrant('atlassian', accountId);
    expect(got.ok && got.val?.accessToken).toBe('access-1');
    expect(got.ok && got.val?.refreshToken).toBe('refresh-1');
  });

  it('a reconnect with an empty refresh token keeps the stored one, re-sealed or not', async () => {
    const set = await setGrant('atlassian', {
      ...base,
      accountId,
      subject,
      accessToken: 'access-2',
      refreshToken: '',
    });
    expect(set.ok).toBe(true);
    const got = await getGrant('atlassian', accountId);
    expect(got.ok && got.val?.accessToken).toBe('access-2');
    expect(got.ok && got.val?.refreshToken).toBe('refresh-1');
  });

  it('a row written under the old deployment key does not open', async () => {
    // The tokens a pre-per-user-key deployment wrote: sealed under the
    // deployment key, stored the way a refresh stores its new tokens.
    await getDataStore().providerGrants.updateSealedTokens('atlassian', accountId, {
      encryptedAccessToken: encrypt('legacy-access', legacyKey),
      encryptedRefreshToken: encrypt('legacy-refresh', legacyKey),
      expiresAt: new Date(base.expiresAt),
      grantedScopes: null,
    });
    const got = await getGrant('atlassian', accountId);
    expect(!got.ok && got.err.type).toBe('DECRYPTION_ERROR');
  });
});

/**
 * A grant with no owner. No write the application makes leaves one (every
 * connect names its subject); such a row is a pre-ownership leftover, so it
 * is seeded as a stored row into a memory store rather than produced.
 */
describe('a provider grant with no owner', () => {
  afterEach(() => resetDataStore());

  it('has no key and does not open', async () => {
    const store = createMemoryDataStore();
    registerDataStore(store);
    await store.seed({
      provider_grants: [
        {
          provider: 'atlassian',
          provider_account_id: 'acct-ownerless',
          subject: null,
          client_id: 'client-1',
          display_name: 'Nobody',
          encrypted_access_token: 'uenc1:opaque',
          encrypted_refresh_token: 'uenc1:opaque',
          expires_at: new Date(Date.now() + 3600_000),
        },
      ],
    });
    const got = await getGrant('atlassian', 'acct-ownerless');
    expect(!got.ok && got.err.type).toBe('DECRYPTION_ERROR');
  });
});

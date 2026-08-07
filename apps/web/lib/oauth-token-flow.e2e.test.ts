/**
 * E2E test: OAuth token flow with mock database
 * Tests: OAuth callback → storage → retrieval → usage
 */

import { randomBytes } from 'crypto';
import { encrypt, decrypt, parseEncryptionKey } from '@renkei/crypto';

/** A `provider_grants` row as the production writer stores it. */
interface GrantRow {
  tenant_id: string;
  provider: string;
  provider_account_id: string;
  client_id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  expires_at: string | Date;
  metadata: { cloudId?: string; siteUrl?: string };
  created_at: Date;
}

describe('OAuth token flow (E2E with mock DB)', () => {
  // Mock database
  class MockDatabase {
    private store: Map<string, GrantRow> = new Map();

    async insert(table: string, data: GrantRow) {
      const key = `${table}:${data.tenant_id}:${data.provider_account_id}`;
      this.store.set(key, data);
      return { id: key };
    }

    async selectOne(table: string, tenantId: string, accountId: string) {
      const key = `${table}:${tenantId}:${accountId}`;
      return this.store.get(key) || null;
    }

    async update(table: string, data: Partial<GrantRow>, tenantId: string, accountId: string) {
      const key = `${table}:${tenantId}:${accountId}`;
      const existing = this.store.get(key);
      if (existing) {
        this.store.set(key, { ...existing, ...data });
      }
      return { updated: !!existing };
    }

    clear() {
      this.store.clear();
    }
  }

  // Helper functions mimicking production code
  const simulateOAuthCallback = (accessToken: string, refreshToken: string) => ({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    token_type: 'Bearer',
  });

  const simulateSetJiraGrant = async (
    db: MockDatabase,
    tenantId: string,
    accountId: string,
    encryptionKey: Buffer,
    grant: {
      accessToken: string;
      refreshToken: string;
      atlassianClientId: string;
      cloudId: string;
      siteUrl: string;
      expiresAt: string | Date;
      // Carried by callers for readability; the writer takes the accountId from
      // its own parameter and does not persist a display name.
      accountId?: string;
      displayName?: string;
    }
  ) => {
    const encryptedAccessToken = encrypt(grant.accessToken, encryptionKey);
    const encryptedRefreshToken = encrypt(grant.refreshToken, encryptionKey);

    await db.insert('provider_grants', {
      tenant_id: tenantId,
      provider: 'atlassian',
      provider_account_id: accountId,
      client_id: grant.atlassianClientId,
      encrypted_access_token: encryptedAccessToken,
      encrypted_refresh_token: encryptedRefreshToken,
      expires_at: grant.expiresAt,
      // Site coordinates are provider-specific and live in metadata, matching
      // what `setJiraGrant` writes to the real table.
      metadata: { siteUrl: grant.siteUrl, cloudId: grant.cloudId },
      created_at: new Date(),
    });
  };

  const simulateGetJiraGrant = async (
    db: MockDatabase,
    tenantId: string,
    accountId: string,
    encryptionKey: Buffer
  ) => {
    const row = await db.selectOne('provider_grants', tenantId, accountId);
    if (!row) return null;

    const accessTokenResult = decrypt(row.encrypted_access_token, encryptionKey);
    const refreshTokenResult = decrypt(row.encrypted_refresh_token, encryptionKey);

    if (!accessTokenResult.ok || !refreshTokenResult.ok) {
      return null;
    }

    return {
      accountId: row.provider_account_id,
      atlassianClientId: row.client_id,
      cloudId: row.metadata?.cloudId,
      siteUrl: row.metadata?.siteUrl,
      accessToken: accessTokenResult.val,
      refreshToken: refreshTokenResult.val,
      expiresAt: row.expires_at,
    };
  };

  const generateValidKey = () => randomBytes(32).toString('base64');

  let db: MockDatabase;
  let encryptionKey: Buffer;

  beforeEach(() => {
    db = new MockDatabase();
    const keyEnv = generateValidKey();
    const keyResult = parseEncryptionKey(keyEnv);
    expect(keyResult.ok).toBe(true);
    encryptionKey = keyResult.ok ? keyResult.val : Buffer.alloc(0);
  });

  it('should complete full OAuth flow: receive → store → retrieve → use', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const accountId = '5b10a2844c20165700ede21g';
    const clientId = 'test-atlassian-client-id';

    // Step 1: OAuth callback receives tokens from Atlassian
    const oauthResponse = simulateOAuthCallback(
      'eyJraWQiOiJhdXRoLmF0bGFzc2lhbi5jb20vY2lkZTMxMTlkOC1jZTU2LTRkODItYjY4Ny00YzQxZDRhNDkwOTQiLCJhbGciOiJSUzI1NiJ9.sample_access_token',
      'AT4xFmF_P0Sx_R1Yt7Nzb00000_sample_refresh_token'
    );

    expect(oauthResponse.access_token).toBeDefined();
    expect(oauthResponse.refresh_token).toBeDefined();

    // Step 2: Store grant in database (encrypted)
    const expiresAt = new Date(Date.now() + oauthResponse.expires_in * 1000);
    await simulateSetJiraGrant(db, tenantId, accountId, encryptionKey, {
      accountId,
      atlassianClientId: clientId,
      cloudId: '00000000-0000-4000-8000-0000000000c1',
      siteUrl: 'https://example.atlassian.net',
      displayName: 'Test User',
      accessToken: oauthResponse.access_token,
      refreshToken: oauthResponse.refresh_token,
      expiresAt: expiresAt.toISOString(),
    });

    // Step 3: Verify grant was stored
    const storedGrant = await db.selectOne('provider_grants', tenantId, accountId);
    if (!storedGrant) throw new Error('grant was not stored');
    expect(storedGrant.encrypted_access_token).not.toBe(oauthResponse.access_token);
    expect(storedGrant.encrypted_refresh_token).not.toBe(oauthResponse.refresh_token);
    console.log('✓ Grant stored with encryption');

    // Step 4: Retrieve and decrypt grant
    const retrievedGrant = await simulateGetJiraGrant(db, tenantId, accountId, encryptionKey);
    expect(retrievedGrant).toBeDefined();
    expect(retrievedGrant?.accountId).toBe(accountId);
    expect(retrievedGrant?.accessToken).toBe(oauthResponse.access_token);
    expect(retrievedGrant?.refreshToken).toBe(oauthResponse.refresh_token);
    console.log('✓ Grant retrieved and decrypted');

    // Step 5: Simulate using token in jiraFetch
    if (retrievedGrant) {
      const authHeader = `Bearer ${retrievedGrant.accessToken}`;
      expect(authHeader).toBe(`Bearer ${oauthResponse.access_token}`);
      console.log('✓ Token ready for use in requests');
    }
  });

  it('should handle token refresh by storing new tokens', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const accountId = '5b10a2844c20165700ede21g';

    // Store initial grant
    const initialGrant = {
      accountId,
      atlassianClientId: 'client123',
      cloudId: 'cloud123',
      siteUrl: 'https://example.atlassian.net',
      displayName: 'User',
      accessToken: 'initial_access_token',
      refreshToken: 'initial_refresh_token',
      expiresAt: new Date().toISOString(),
    };

    await simulateSetJiraGrant(db, tenantId, accountId, encryptionKey, initialGrant);

    // Simulate token refresh: new tokens from refresh endpoint
    const refreshedAccessToken = 'new_access_token_after_refresh';
    const refreshedRefreshToken = 'new_refresh_token_after_refresh';

    // Update database with new tokens
    const encryptedAccessToken = encrypt(refreshedAccessToken, encryptionKey);
    const encryptedRefreshToken = encrypt(refreshedRefreshToken, encryptionKey);

    await db.update(
      'provider_grants',
      {
        encrypted_access_token: encryptedAccessToken,
        encrypted_refresh_token: encryptedRefreshToken,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      tenantId,
      accountId
    );

    // Verify new tokens are stored and retrievable
    const updatedGrant = await simulateGetJiraGrant(db, tenantId, accountId, encryptionKey);
    expect(updatedGrant?.accessToken).toBe(refreshedAccessToken);
    expect(updatedGrant?.refreshToken).toBe(refreshedRefreshToken);
    console.log('✓ Token refresh and update successful');
  });

  it('should prevent decryption with wrong key', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const accountId = '5b10a2844c20165700ede21g';

    // Store with correct key
    const grant = {
      accountId,
      atlassianClientId: 'client123',
      cloudId: 'cloud123',
      siteUrl: 'https://example.atlassian.net',
      displayName: 'User',
      accessToken: 'secret_token_12345',
      refreshToken: 'secret_refresh_token',
      expiresAt: new Date().toISOString(),
    };

    await simulateSetJiraGrant(db, tenantId, accountId, encryptionKey, grant);

    // Try to decrypt with wrong key
    const wrongKeyEnv = generateValidKey();
    const wrongKeyResult = parseEncryptionKey(wrongKeyEnv);
    expect(wrongKeyResult.ok).toBe(true);
    const wrongKey = wrongKeyResult.ok ? wrongKeyResult.val : Buffer.alloc(0);

    const row = await db.selectOne('provider_grants', tenantId, accountId);
    if (!row) throw new Error('grant was not stored');
    const decryptResult = decrypt(row.encrypted_access_token, wrongKey);

    expect(decryptResult.ok).toBe(false);
    console.log('✓ Wrong key prevents decryption');
  });

  it('should handle concurrent token retrievals', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const accountId = '5b10a2844c20165700ede21g';

    const grant = {
      accountId,
      atlassianClientId: 'client123',
      cloudId: 'cloud123',
      siteUrl: 'https://example.atlassian.net',
      displayName: 'User',
      accessToken: 'concurrent_test_token',
      refreshToken: 'concurrent_test_refresh',
      expiresAt: new Date().toISOString(),
    };

    await simulateSetJiraGrant(db, tenantId, accountId, encryptionKey, grant);

    // Simulate concurrent retrievals
    const promises = Array.from({ length: 5 }, () =>
      simulateGetJiraGrant(db, tenantId, accountId, encryptionKey)
    );

    const results = await Promise.all(promises);

    // All should return the same token
    results.forEach((result) => {
      expect(result?.accessToken).toBe(grant.accessToken);
      expect(result?.refreshToken).toBe(grant.refreshToken);
    });

    console.log('✓ Concurrent retrievals successful');
  });

  it('should isolate grants by tenantId and accountId', async () => {
    const tenantId1 = 'tenant-1';
    const tenantId2 = 'tenant-2';
    const accountId1 = 'account-1';
    const accountId2 = 'account-2';

    const grant1 = {
      accountId: accountId1,
      atlassianClientId: 'client1',
      cloudId: 'cloud1',
      siteUrl: 'https://site1.atlassian.net',
      displayName: 'User1',
      accessToken: 'token1',
      refreshToken: 'refresh1',
      expiresAt: new Date().toISOString(),
    };

    const grant2 = {
      accountId: accountId2,
      atlassianClientId: 'client2',
      cloudId: 'cloud2',
      siteUrl: 'https://site2.atlassian.net',
      displayName: 'User2',
      accessToken: 'token2',
      refreshToken: 'refresh2',
      expiresAt: new Date().toISOString(),
    };

    await simulateSetJiraGrant(db, tenantId1, accountId1, encryptionKey, grant1);
    await simulateSetJiraGrant(db, tenantId2, accountId2, encryptionKey, grant2);

    // Verify isolation
    const retrieved1 = await simulateGetJiraGrant(db, tenantId1, accountId1, encryptionKey);
    const retrieved2 = await simulateGetJiraGrant(db, tenantId2, accountId2, encryptionKey);

    expect(retrieved1?.accessToken).toBe('token1');
    expect(retrieved2?.accessToken).toBe('token2');
    console.log('✓ Grants isolated by tenantId and accountId');
  });
});

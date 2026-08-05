import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db.types';
import { getDatabase } from '@/lib/db';
import { encrypt, decrypt, parseEncryptionKey } from '@/lib/crypto/secretbox';
import { randomUUID } from 'crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { logger } from '@/lib/logger';

export interface TenantOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  roleClaim?: string;
  operatorIdpValue?: string | null;
  userIdpValue?: string | null;
}

/**
 * Provider key for Atlassian grants in `provider_grants`. Jira and Confluence
 * are products *of* this provider and share one credential, so the product a
 * caller wants is carried on the MCP access token, not here.
 */
export const ATLASSIAN = 'atlassian';

/**
 * Atlassian keeps its site identity in the grant's `metadata` jsonb. Read it
 * defensively: the column is provider-shaped, so nothing in the schema
 * guarantees these keys are present on a given row.
 */
function readAtlassianMetadata(metadata: unknown): { cloudId: string; siteUrl: string } {
  if (typeof metadata !== 'object' || metadata === null) return { cloudId: '', siteUrl: '' };
  const record: Record<string, unknown> = { ...metadata };
  return {
    cloudId: typeof record.cloudId === 'string' ? record.cloudId : '',
    siteUrl: typeof record.siteUrl === 'string' ? record.siteUrl : '',
  };
}

export interface JiraGrant {
  accountId: string;
  atlassianClientId: string;
  cloudId: string;
  siteUrl: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
  /**
   * OIDC subject of the signed-in user who connected this grant. Null only for
   * rows created before grants were owned — those are unusable and must not be
   * served to a caller, since we cannot tell whose Jira account they are.
   */
  subject: string | null;
}

/** Writes always record an owner; only reads can surface a legacy unowned row. */
export type NewJiraGrant = Omit<JiraGrant, 'subject'> & { subject: string };

/**
 * Store OIDC configuration for a tenant.
 * Client secret is encrypted with the deployment key.
 */
export async function setTenantOidc(
  tenantId: string,
  oidc: TenantOidc
): Promise<Result<void, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const encryptedSecret = encrypt(oidc.clientSecret, encryptionKey);

  const result = await wrapAsync(
    () =>
      db
        .insertInto('tenant_oidc')
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          issuer: oidc.issuer,
          client_id: oidc.clientId,
          client_secret: encryptedSecret,
          role_claim: oidc.roleClaim,
          operator_idp_value: oidc.operatorIdpValue || null,
          user_idp_value: oidc.userIdpValue || null,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.column('tenant_id').doUpdateSet({
            issuer: oidc.issuer,
            client_id: oidc.clientId,
            client_secret: encryptedSecret,
            role_claim: oidc.roleClaim,
            operator_idp_value: oidc.operatorIdpValue || null,
            user_idp_value: oidc.userIdpValue || null,
          })
        )
        .execute(),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  return ok();
}

/**
 * Store OIDC role mapping (IDP role -> renkei role).
 */
export async function setOidcRoleMapping(
  tenantId: string,
  idpRole: string,
  renkeiRole: string
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const result = await wrapAsync(
    () =>
      db
        .insertInto('oidc_role_mappings')
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          idp_role: idpRole,
          renkei_role: renkeiRole,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'idp_role']).doUpdateSet({
            renkei_role: renkeiRole,
          })
        )
        .execute(),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  return ok();
}

/**
 * Get renkei role for an IDP role.
 */
export async function getOidcRoleMapping(
  tenantId: string,
  idpRole: string
): Promise<Result<string | null, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const rowResult = await wrapAsync(
    () =>
      db
        .selectFrom('oidc_role_mappings')
        .select('renkei_role')
        .where('tenant_id', '=', tenantId)
        .where('idp_role', '=', idpRole)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );

  if (!rowResult.ok) return rowResult;
  return ok(rowResult.val?.renkei_role || null);
}

/**
 * Get OIDC configuration for a tenant.
 * Client secret is automatically decrypted.
 */
export async function getTenantOidc(
  tenantId: string
): Promise<Result<TenantOidc | null, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY' | 'DECRYPTION_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const rowResult = await wrapAsync(
    () =>
      db
        .selectFrom('tenant_oidc')
        .select([
          'issuer',
          'client_id',
          'client_secret',
          'role_claim',
          'operator_idp_value',
          'user_idp_value',
        ])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );

  if (!rowResult.ok) return rowResult;

  const row = rowResult.val;
  if (!row) return ok(null);

  const decryptedSecretResult = decrypt(row.client_secret, encryptionKey);
  if (!decryptedSecretResult.ok) return err('DECRYPTION_ERROR' as const);

  return ok({
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret: decryptedSecretResult.val,
    roleClaim: row.role_claim || undefined,
    operatorIdpValue: row.operator_idp_value || undefined,
    userIdpValue: row.user_idp_value || undefined,
  });
}

/**
 * Store encrypted Jira grant for a tenant user.
 */
export async function setJiraGrant(
  tenantId: string,
  grant: NewJiraGrant
): Promise<Result<void, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const encryptedAccessToken = encrypt(grant.accessToken, encryptionKey);
  const encryptedRefreshToken = encrypt(grant.refreshToken, encryptionKey);

  const result = await wrapAsync(
    () =>
      db
        .insertInto('provider_grants')
        .values({
          tenant_id: tenantId,
          provider: ATLASSIAN,
          provider_account_id: grant.accountId,
          client_id: grant.atlassianClientId,
          display_name: grant.displayName || grant.accountId,
          subject: grant.subject,
          encrypted_access_token: encryptedAccessToken,
          encrypted_refresh_token: encryptedRefreshToken,
          expires_at: grant.expiresAt,
          scopes: grant.scopes,
          // Site identity is Atlassian-specific, so it lives in metadata rather
          // than as columns every other provider would leave NULL.
          metadata: JSON.stringify({ cloudId: grant.cloudId, siteUrl: grant.siteUrl }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'provider', 'provider_account_id']).doUpdateSet({
            encrypted_access_token: encryptedAccessToken,
            encrypted_refresh_token: encryptedRefreshToken,
            expires_at: grant.expiresAt,
            metadata: JSON.stringify({ cloudId: grant.cloudId, siteUrl: grant.siteUrl }),
            updated_at: new Date().toISOString(),
            // Re-stamp on reconnect so grants predating per-user ownership get
            // an owner, and so a re-auth by a different user reassigns cleanly.
            subject: grant.subject,
          })
        )
        .execute(),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  return ok();
}

/**
 * Get decrypted Jira grant for a tenant user.
 */
export async function getJiraGrant(
  tenantId: string,
  accountId: string
): Promise<Result<JiraGrant | null, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY' | 'DECRYPTION_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const rowResult = await wrapAsync(
    () =>
      db
        .selectFrom('provider_grants')
        .select([
          'provider_account_id',
          'client_id',
          'display_name',
          'metadata',
          'encrypted_access_token',
          'encrypted_refresh_token',
          'expires_at',
          'scopes',
          'tenant_id',
          'subject',
        ])
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', ATLASSIAN)
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );

  if (!rowResult.ok) return rowResult;

  const row = rowResult.val;
  if (!row) return ok(null);

  const accessTokenResult = decrypt(row.encrypted_access_token, encryptionKey);
  if (!accessTokenResult.ok) return err('DECRYPTION_ERROR' as const);

  const refreshTokenResult = decrypt(row.encrypted_refresh_token, encryptionKey);
  if (!refreshTokenResult.ok) return err('DECRYPTION_ERROR' as const);

  const site = readAtlassianMetadata(row.metadata);

  // Return grant as-is; refresh on 401 is handled by jiraFetchWithRefresh
  return ok({
    accountId: row.provider_account_id,
    subject: row.subject,
    atlassianClientId: row.client_id,
    cloudId: site.cloudId,
    siteUrl: site.siteUrl,
    displayName: row.display_name || '',
    accessToken: accessTokenResult.val,
    refreshToken: refreshTokenResult.val,
    expiresAt: row.expires_at.toISOString(),
    scopes: row.scopes,
  });
}

/**
 * Acquire distributed lock for token refresh.
 * Returns true if lock acquired, false if another process holds it.
 */
async function acquireRefreshLock(
  db: Kysely<DB>,
  tenantId: string,
  accountId: string
): Promise<boolean> {
  try {
    await db
      .insertInto('atlassian_refresh_locks')
      .values({
        tenant_id: tenantId,
        account_id: accountId,
        locked_at: new Date(),
      })
      .execute();
    return true;
  } catch {
    return false;
  }
}

/**
 * Release distributed lock for token refresh.
 */
async function releaseRefreshLock(
  db: Kysely<DB>,
  tenantId: string,
  accountId: string
): Promise<void> {
  try {
    await db
      .deleteFrom('atlassian_refresh_locks')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .execute();
  } catch {
    // Ignore errors on release
  }
}

/**
 * Wait for lock to be released by another process.
 * Polls with exponential backoff, max 10 seconds.
 */
async function waitForRefreshLock(
  db: Kysely<DB>,
  tenantId: string,
  accountId: string
): Promise<void> {
  let attempts = 0;
  const maxAttempts = 20;

  while (attempts < maxAttempts) {
    const lock = await db
      .selectFrom('atlassian_refresh_locks')
      .select('locked_at')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!lock) {
      return;
    }

    const lockAgeMs = Date.now() - lock.locked_at.getTime();
    if (lockAgeMs > 5 * 60 * 1000) {
      await releaseRefreshLock(db, tenantId, accountId);
      return;
    }

    const delayMs = Math.min(50 * Math.pow(2, attempts), 500);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempts++;
  }
}

/**
 * Refresh an expired Atlassian OAuth token using the refresh token.
 * Updates the database with new tokens.
 * Exported for use by MCP tool layer (e.g., on 401 responses).
 */
export async function refreshAtlassianTokenDirect(
  tenantId: string,
  accountId: string
): Promise<
  Result<
    { accessToken: string; refreshToken: string; expiresAt: Date },
    'REFRESH_FAILED' | 'GRANT_REVOKED'
  >
> {
  logger.info('[Refresh] Starting token refresh', { tenantId, accountId });
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('[Refresh] Database unavailable', { tenantId, accountId });
    return err('REFRESH_FAILED' as const);
  }
  const db = dbResult.val;

  try {
    // Try to acquire distributed lock
    const lockAcquired = await acquireRefreshLock(db, tenantId, accountId);
    if (!lockAcquired) {
      logger.debug('[Refresh] Lock not acquired, waiting for other process', {
        tenantId,
        accountId,
      });
      // Another process is refreshing; wait for them to finish
      await waitForRefreshLock(db, tenantId, accountId);
      // Re-fetch grant (the other process may have updated it)
      const refetchResult = await getJiraGrant(tenantId, accountId);
      if (refetchResult.ok && refetchResult.val) {
        logger.info('[Refresh] Using refreshed token from other process', { tenantId, accountId });
        return ok({
          accessToken: refetchResult.val.accessToken,
          refreshToken: refetchResult.val.refreshToken,
          expiresAt: new Date(refetchResult.val.expiresAt),
        });
      }
      logger.debug('[Refresh] Re-fetch failed, proceeding with refresh', { tenantId, accountId });
      // If re-fetch fails, fall through to refresh
    }

    const grant = await db
      .selectFrom('provider_grants')
      .select(['client_id', 'encrypted_refresh_token'])
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', ATLASSIAN)
      .where('provider_account_id', '=', accountId)
      .executeTakeFirst();

    if (!grant) {
      logger.error('[Refresh] No grant found', { tenantId, accountId });
      await releaseRefreshLock(db, tenantId, accountId);
      return err('REFRESH_FAILED' as const);
    }

    // Decrypt refresh token
    const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (!encryptionKeyResult.ok) {
      logger.error('[Refresh] Failed to parse encryption key', { tenantId, accountId });
      return err('REFRESH_FAILED' as const);
    }
    const encryptionKey = encryptionKeyResult.val;

    const decryptedRefreshTokenResult = decrypt(grant.encrypted_refresh_token, encryptionKey);
    if (!decryptedRefreshTokenResult.ok) {
      logger.error('[Refresh] Failed to decrypt refresh token', { tenantId, accountId });
      return err('REFRESH_FAILED' as const);
    }
    const refreshToken = decryptedRefreshTokenResult.val;

    // client_secret is required for the refresh_token grant, same as the initial
    // code exchange. Omitting it yields 401 access_denied / "Unauthorized".
    const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET || '';
    if (!clientSecret) {
      logger.error('[Refresh] ATLASSIAN_CLIENT_SECRET is not configured', { tenantId, accountId });
      return err('REFRESH_FAILED' as const);
    }

    logger.debug('[Refresh] Calling token endpoint', {
      tenantId,
      accountId,
      clientId: grant.client_id,
    });
    // Call Atlassian OAuth token endpoint
    const response = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: grant.client_id,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    logger.debug('[Refresh] Token endpoint response', {
      tenantId,
      accountId,
      status: response.status,
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      logger.error('[Refresh] Token endpoint error', {
        tenantId,
        accountId,
        status: response.status,
        error: errorData.error,
        errorDescription: errorData.error_description,
      });
      // Only invalid_grant means the refresh token is genuinely dead. Every other
      // failure (client auth, network, 5xx) is ours to fix — deleting the grant
      // there destroys a working authorization and forces a pointless re-consent.
      if (errorData.error === 'invalid_grant') {
        logger.warn('[Refresh] Refresh token rejected, deleting grant', { tenantId, accountId });
        await db
          .deleteFrom('provider_grants')
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', ATLASSIAN)
          .where('provider_account_id', '=', accountId)
          .execute();
        return err('GRANT_REVOKED' as const);
      }
      return err('REFRESH_FAILED' as const);
    }

    const data = await response.json();

    if (!data.access_token || !data.refresh_token) {
      logger.error('[Refresh] Token response missing required fields', {
        tenantId,
        accountId,
        hasAccessToken: !!data.access_token,
        hasRefreshToken: !!data.refresh_token,
      });
      return err('REFRESH_FAILED' as const);
    }

    const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);

    const encryptedAccessToken = encrypt(data.access_token, encryptionKey);
    const encryptedRefreshToken = encrypt(data.refresh_token, encryptionKey);

    logger.debug('[Refresh] Updating grant in database', { tenantId, accountId });
    const updateResult = await wrapAsync(
      () =>
        db
          .updateTable('provider_grants')
          .set({
            encrypted_access_token: encryptedAccessToken,
            encrypted_refresh_token: encryptedRefreshToken,
            expires_at: expiresAt,
            updated_at: new Date(),
          })
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', ATLASSIAN)
          .where('provider_account_id', '=', accountId)
          .execute(),
      'REFRESH_FAILED' as const
    );

    if (!updateResult.ok) {
      logger.error('[Refresh] Failed to update grant', { tenantId, accountId });
      return updateResult;
    }

    logger.info('[Refresh] Token refreshed successfully', {
      tenantId,
      accountId,
      expiresAt: expiresAt.toISOString(),
    });
    return ok({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    });
  } catch (error) {
    logger.error('[Refresh] Unexpected error during refresh', {
      tenantId,
      accountId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return err('REFRESH_FAILED' as const);
  } finally {
    // Always release the lock
    await releaseRefreshLock(db, tenantId, accountId);
  }
}

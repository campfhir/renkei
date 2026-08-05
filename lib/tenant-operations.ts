import { getDatabase } from '@/lib/db';
import { encrypt, decrypt, parseEncryptionKey } from '@/lib/crypto/secretbox';
import { randomUUID } from 'crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface TenantOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  roleClaim?: string;
  operatorIdpValue?: string | null;
  userIdpValue?: string | null;
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
}

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
  grant: JiraGrant
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
        .insertInto('atlassian_grants')
        .values({
          account_id: grant.accountId,
          tenant_id: tenantId,
          atlassian_client_id: grant.atlassianClientId,
          cloud_id: grant.cloudId,
          site_url: grant.siteUrl,
          operator_name: grant.displayName || grant.accountId,
          encrypted_access_token: encryptedAccessToken,
          encrypted_refresh_token: encryptedRefreshToken,
          expires_at: grant.expiresAt,
          scopes: grant.scopes,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.columns(['account_id', 'tenant_id']).doUpdateSet({
            encrypted_access_token: encryptedAccessToken,
            encrypted_refresh_token: encryptedRefreshToken,
            expires_at: grant.expiresAt,
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
        .selectFrom('atlassian_grants')
        .select([
          'account_id',
          'atlassian_client_id',
          'cloud_id',
          'site_url',
          'operator_name',
          'encrypted_access_token',
          'encrypted_refresh_token',
          'expires_at',
          'scopes',
          'tenant_id',
        ])
        .where('tenant_id', '=', tenantId)
        .where('account_id', '=', accountId)
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

  // Return grant as-is; refresh on 401 is handled by jiraFetchWithRefresh
  return ok({
    accountId: row.account_id,
    atlassianClientId: row.atlassian_client_id,
    cloudId: row.cloud_id,
    siteUrl: row.site_url || '',
    displayName: row.operator_name || '',
    accessToken: accessTokenResult.val,
    refreshToken: refreshTokenResult.val,
    expiresAt: row.expires_at.toISOString(),
    scopes: row.scopes,
  });
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
  try {
    // Get database and current grant to retrieve clientId and refreshToken
    const dbResult = getDatabase();
    if (!dbResult.ok) return err('REFRESH_FAILED' as const);
    const db = dbResult.val;

    const grant = await db
      .selectFrom('atlassian_grants')
      .select(['atlassian_client_id', 'encrypted_refresh_token'])
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!grant) {
      return err('REFRESH_FAILED' as const);
    }

    // Decrypt refresh token
    const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (!encryptionKeyResult.ok) return err('REFRESH_FAILED' as const);
    const encryptionKey = encryptionKeyResult.val;

    const decryptedRefreshTokenResult = decrypt(grant.encrypted_refresh_token, encryptionKey);
    if (!decryptedRefreshTokenResult.ok) return err('REFRESH_FAILED' as const);
    const refreshToken = decryptedRefreshTokenResult.val;

    // Call Atlassian OAuth token endpoint
    const response = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: grant.atlassian_client_id,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      // Check if refresh token is invalid/revoked
      const errorData = await response.json().catch(() => ({}));
      if (errorData.error === 'invalid_grant' || response.status === 401) {
        // Refresh token is burned; delete the grant so user must re-authenticate
        await db
          .deleteFrom('atlassian_grants')
          .where('tenant_id', '=', tenantId)
          .where('account_id', '=', accountId)
          .execute();
        return err('GRANT_REVOKED' as const);
      }
      return err('REFRESH_FAILED' as const);
    }

    const data = await response.json();

    if (!data.access_token || !data.refresh_token) {
      return err('REFRESH_FAILED' as const);
    }

    // Calculate new expiration
    const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);

    const encryptedAccessToken = encrypt(data.access_token, encryptionKey);
    const encryptedRefreshToken = encrypt(data.refresh_token, encryptionKey);

    await wrapAsync(
      () =>
        db
          .updateTable('atlassian_grants')
          .set({
            encrypted_access_token: encryptedAccessToken,
            encrypted_refresh_token: encryptedRefreshToken,
            expires_at: expiresAt,
          })
          .where('tenant_id', '=', tenantId)
          .where('account_id', '=', accountId)
          .execute(),
      'REFRESH_FAILED' as const
    );

    return ok({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    });
  } catch {
    return err('REFRESH_FAILED' as const);
  }
}

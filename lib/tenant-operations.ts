import { getDatabase } from '@/lib/db';
import { encrypt, decrypt, parseEncryptionKey } from '@/lib/crypto/secretbox';
import { randomUUID } from 'crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
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
export async function setTenantOidc(tenantId: string, oidc: TenantOidc): Promise<Result<void, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const encryptedSecret = encrypt(oidc.clientSecret, encryptionKey);

  try {
    await db
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
      .execute();
    return ok();
  } catch (error) {
    return err('DB_ERROR' as const);
  }
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

  try {
    await db
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
      .execute();
    return ok();
  } catch (error) {
    return err('DB_ERROR' as const);
  }
}

/**
 * Get renkei role for an IDP role.
 */
export async function getOidcRoleMapping(tenantId: string, idpRole: string): Promise<Result<string | null, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  try {
    const row = await db
      .selectFrom('oidc_role_mappings')
      .select('renkei_role')
      .where('tenant_id', '=', tenantId)
      .where('idp_role', '=', idpRole)
      .executeTakeFirst();

    return ok(row?.renkei_role || null);
  } catch (error) {
    return err('DB_ERROR' as const);
  }
}

/**
 * Get OIDC configuration for a tenant.
 * Client secret is automatically decrypted.
 */
export async function getTenantOidc(tenantId: string): Promise<Result<TenantOidc | null, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY' | 'DECRYPTION_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  try {
    const row = await db
      .selectFrom('tenant_oidc')
      .select(['issuer', 'client_id', 'client_secret', 'role_claim', 'operator_idp_value', 'user_idp_value'])
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

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
  } catch (error) {
    return err('DB_ERROR' as const);
  }
}

/**
 * Store encrypted Jira grant for a tenant user.
 */
export async function setJiraGrant(tenantId: string, grant: JiraGrant): Promise<Result<void, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const encryptedAccessToken = encrypt(grant.accessToken, encryptionKey);
  const encryptedRefreshToken = encrypt(grant.refreshToken, encryptionKey);

  try {
    await db
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
      .execute();
    return ok();
  } catch (error) {
    return err('DB_ERROR' as const);
  }
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

  try {
    const row = await db
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
      ])
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!row) return ok(null);

    const accessTokenResult = decrypt(row.encrypted_access_token, encryptionKey);
    if (!accessTokenResult.ok) return err('DECRYPTION_ERROR' as const);

    const refreshTokenResult = decrypt(row.encrypted_refresh_token, encryptionKey);
    if (!refreshTokenResult.ok) return err('DECRYPTION_ERROR' as const);

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
  } catch (error) {
    return err('DB_ERROR' as const);
  }
}

import { getDatabase } from '@/lib/db';
import { encrypt, decrypt, parseEncryptionKey } from '@/lib/crypto/secretbox';
import { randomUUID } from 'crypto';

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
export async function setTenantOidc(tenantId: string, oidc: TenantOidc): Promise<void> {
  const db = getDatabase();
  const encryptionKey = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');

  const encryptedSecret = encrypt(oidc.clientSecret, encryptionKey);

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
}

/**
 * Store OIDC role mapping (IDP role -> renkei role).
 */
export async function setOidcRoleMapping(
  tenantId: string,
  idpRole: string,
  renkeiRole: string
): Promise<void> {
  const db = getDatabase();

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
}

/**
 * Get renkei role for an IDP role.
 */
export async function getOidcRoleMapping(tenantId: string, idpRole: string): Promise<string | null> {
  const db = getDatabase();

  const row = await db
    .selectFrom('oidc_role_mappings')
    .select('renkei_role')
    .where('tenant_id', '=', tenantId)
    .where('idp_role', '=', idpRole)
    .executeTakeFirst();

  return row?.renkei_role || null;
}

/**
 * Get OIDC configuration for a tenant.
 * Client secret is automatically decrypted.
 */
export async function getTenantOidc(tenantId: string): Promise<TenantOidc | null> {
  const db = getDatabase();
  const encryptionKey = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');

  const row = await db
    .selectFrom('tenant_oidc')
    .select(['issuer', 'client_id', 'client_secret', 'role_claim', 'operator_idp_value', 'user_idp_value'])
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();

  if (!row) return null;

  return {
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret: decrypt(row.client_secret, encryptionKey),
    roleClaim: row.role_claim || undefined,
    operatorIdpValue: row.operator_idp_value || undefined,
    userIdpValue: row.user_idp_value || undefined,
  };
}

/**
 * Store encrypted Jira grant for a tenant user.
 */
export async function setJiraGrant(tenantId: string, grant: JiraGrant): Promise<void> {
  const db = getDatabase();
  const encryptionKey = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');

  const encryptedAccessToken = encrypt(grant.accessToken, encryptionKey);
  const encryptedRefreshToken = encrypt(grant.refreshToken, encryptionKey);

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
}

/**
 * Get decrypted Jira grant for a tenant user.
 */
export async function getJiraGrant(
  tenantId: string,
  accountId: string
): Promise<JiraGrant | null> {
  const db = getDatabase();
  const encryptionKey = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');

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

  if (!row) return null;

  return {
    accountId: row.account_id,
    atlassianClientId: row.atlassian_client_id,
    cloudId: row.cloud_id,
    siteUrl: row.site_url || '',
    displayName: row.operator_name || '',
    accessToken: decrypt(row.encrypted_access_token, encryptionKey),
    refreshToken: decrypt(row.encrypted_refresh_token, encryptionKey),
    expiresAt: row.expires_at.toISOString(),
    scopes: row.scopes,
  };
}

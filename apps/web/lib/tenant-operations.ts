import { encrypt, decrypt, parseEncryptionKey } from '@renkei/crypto';
import { randomUUID } from 'crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getDatabase } from '@renkei/db';
import { readConnectorConfigCached } from '@renkei/connector-config';
import {
  ATLASSIAN,
  AtlassianAdapter,
  getGrant,
  setGrant,
  readAtlassianMetadata,
  refreshGrantTokens,
} from '@renkei/provider-grants';
import { logger } from '@/lib/logger';

export { ATLASSIAN };

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
  /** What the (possibly user-narrowed) authorize step asked Atlassian for. */
  requestedScopes: string[];
  /** What the minted token actually carries, from its claims; null = unknown. */
  grantedScopes: string[] | null;
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
/**
 * Configure a tenant's identity provider only if it has none.
 *
 * Resolves to false when a configuration already existed, leaving it
 * untouched. The unauthenticated bootstrap path needs this rather than
 * `setTenantOidc`: that one upserts, so two racing callers would both pass a
 * "not configured yet" check and the later write would silently replace the
 * earlier. Letting the database decide makes first-write-wins actually true.
 */
export async function createTenantOidcIfAbsent(
  tenantId: string,
  oidc: TenantOidc
): Promise<Result<boolean, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const result = await wrapAsync(
    () =>
      db
        .insertInto('tenant_oidc')
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          issuer: oidc.issuer,
          client_id: oidc.clientId,
          client_secret: encrypt(oidc.clientSecret, encryptionKey),
          role_claim: oidc.roleClaim,
          operator_idp_value: oidc.operatorIdpValue || null,
          user_idp_value: oidc.userIdpValue || null,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.column('tenant_id').doNothing())
        .executeTakeFirst(),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  // A bigint literal would need an ES2020 target; Number() is safe for a count
  // that is only ever 0 or 1.
  return ok(Number(result.val?.numInsertedOrUpdatedRows ?? 0) > 0);
}

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
 *
 * A façade over @renkei/provider-grants: this module supplies the deployment
 * configuration (encryption key from env) and maps the Atlassian site
 * identity into the provider-shaped metadata; the lifecycle lives in the
 * package.
 */
export async function setJiraGrant(
  tenantId: string,
  grant: NewJiraGrant
): Promise<Result<void, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY'>> {
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);

  return setGrant(
    ATLASSIAN,
    tenantId,
    {
      accountId: grant.accountId,
      clientId: grant.atlassianClientId,
      displayName: grant.displayName,
      subject: grant.subject,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      requestedScopes: grant.requestedScopes,
      grantedScopes: grant.grantedScopes,
      // Site identity is Atlassian-specific, so it lives in metadata rather
      // than as columns every other provider would leave NULL.
      metadata: { cloudId: grant.cloudId, siteUrl: grant.siteUrl },
    },
    encryptionKeyResult.val
  );
}

/**
 * Get decrypted Jira grant for a tenant user. Façade over the package store,
 * flattening Atlassian's metadata into the JiraGrant shape callers expect.
 */
export async function getJiraGrant(
  tenantId: string,
  accountId: string
): Promise<Result<JiraGrant | null, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY' | 'DECRYPTION_ERROR'>> {
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);

  const grantResult = await getGrant(ATLASSIAN, tenantId, accountId, encryptionKeyResult.val);
  if (!grantResult.ok) return grantResult;

  const grant = grantResult.val;
  if (!grant) return ok(null);

  const site = readAtlassianMetadata(grant.metadata);

  // Return grant as-is; refresh on 401 is handled by the MCP tool layer.
  return ok({
    accountId: grant.accountId,
    subject: grant.subject,
    atlassianClientId: grant.clientId,
    cloudId: site.cloudId,
    siteUrl: site.siteUrl,
    displayName: grant.displayName,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
    requestedScopes: grant.requestedScopes,
    grantedScopes: grant.grantedScopes,
  });
}
/**
 * Refresh an expired Atlassian OAuth token using the refresh token.
 * Updates the database with new tokens.
 * Exported for use by MCP tool layer (e.g., on 401 responses).
 *
 * Façade over @renkei/provider-grants: the cross-process locking, revoked-
 * grant cleanup, and persistence live in the package; this supplies the
 * Atlassian adapter (client secret from env), the encryption key, and the
 * app logger.
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
  const encryptionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!encryptionKeyResult.ok) {
    logger.error('Failed to parse encryption key', {
      component: 'grants/refresh',
      tenantId,
      accountId,
    });
    return err('REFRESH_FAILED' as const);
  }

  // The client secret is org connector configuration in the database, like
  // the rest of the Atlassian app registration.
  const configResult = await readConnectorConfigCached(
    tenantId,
    ATLASSIAN,
    encryptionKeyResult.val
  );
  if (!configResult.ok || !configResult.val?.secrets.clientSecret) {
    logger.error('Atlassian connector config missing; cannot refresh', {
      component: 'grants/refresh',
      tenantId,
      accountId,
    });
    return err('REFRESH_FAILED' as const);
  }

  const adapter = new AtlassianAdapter(configResult.val.secrets.clientSecret);
  return refreshGrantTokens(adapter, tenantId, accountId, encryptionKeyResult.val, logger);
}

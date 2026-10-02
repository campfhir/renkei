import { encrypt, decrypt, parseEncryptionKey } from '@renkei/crypto';
import { randomUUID } from 'crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getDatabase } from '@renkei/db';
import { ATLASSIAN, setGrant } from '@renkei/provider-grants';

export { ATLASSIAN };

export interface TenantOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  roleClaim?: string;
  operatorIdpValue?: string | null;
  userIdpValue?: string | null;
  /**
   * The id_token claim carrying a person's groups, read at sign-in for
   * connector audience rules. Absent means the conventional 'groups'.
   */
  groupsClaim?: string | null;
}

/** What sign-in reads for groups when the tenant has not said otherwise. */
export const DEFAULT_GROUPS_CLAIM = 'groups';

/** The claim-mapping half of the OIDC config: editable without the client secret. */
export interface TenantOidcClaims {
  roleClaim?: string | null;
  operatorIdpValue?: string | null;
  userIdpValue?: string | null;
  groupsClaim?: string | null;
}

/**
 * The shape the OAuth callback hands `setJiraGrant`. Token material lives
 * here only on the way INTO the store (docs/delegate-key-design.md,
 * "Phase 1 as built"): nothing in the web app reads a grant's tokens back —
 * the delegate worker does, behind `@renkei/delegate-client`.
 */
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
          groups_claim: oidc.groupsClaim || null,
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
            groups_claim: oidc.groupsClaim || null,
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
          'groups_claim',
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
    groupsClaim: row.groups_claim || undefined,
  });
}

/**
 * The claim mappings alone, for the admin settings page. The full
 * setTenantOidc needs the client secret and is what the organization
 * bootstrap uses; changing which claim carries groups should not demand
 * re-entering a secret or re-running discovery.
 */
export async function getTenantOidcClaims(
  tenantId: string
): Promise<Result<TenantOidcClaims | null, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('tenant_oidc')
        .select(['role_claim', 'operator_idp_value', 'user_idp_value', 'groups_claim'])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;
  const row = rowResult.val;
  if (!row) return ok(null);
  return ok({
    roleClaim: row.role_claim,
    operatorIdpValue: row.operator_idp_value,
    userIdpValue: row.user_idp_value,
    groupsClaim: row.groups_claim,
  });
}

/** Update only the claim mappings; false when the tenant has no OIDC row to update. */
export async function setTenantOidcClaims(
  tenantId: string,
  claims: TenantOidcClaims
): Promise<Result<boolean, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const result = await wrapAsync(
    () =>
      dbResult.val
        .updateTable('tenant_oidc')
        .set({
          role_claim: claims.roleClaim || null,
          operator_idp_value: claims.operatorIdpValue || null,
          user_idp_value: claims.userIdpValue || null,
          groups_claim: claims.groupsClaim || null,
        })
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok(Number(result.val.numUpdatedRows) > 0);
}

/**
 * Store encrypted Jira grant for a tenant user.
 *
 * A façade over @renkei/provider-grants: this module supplies the deployment
 * configuration (encryption key from env) and maps the Atlassian site
 * identity into the provider-shaped metadata; the lifecycle lives in the
 * package. Kept for the OAuth callback's current write path; once the
 * callback commits through the delegate (`oauth/exchange` + `grant/commit`)
 * this becomes unused and can go.
 */
export async function setJiraGrant(
  tenantId: string,
  grant: NewJiraGrant
): Promise<Result<void, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY'>> {
  return setGrant(ATLASSIAN, tenantId, {
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
  });
}

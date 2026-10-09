import { encrypt, decrypt, loadKeyring } from '@renkei/crypto';
import { randomUUID } from 'crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getDatabase } from '@renkei/db';
import { ATLASSIAN } from '@renkei/provider-grants';

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
  const encryptionKeyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const result = await wrapAsync(
    () =>
      db
        .insertInto('tenant_oidc')
        .values({
          id: randomUUID(),
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
  const encryptionKeyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const encryptedSecret = encrypt(oidc.clientSecret, encryptionKey);

  const result = await wrapAsync(
    () =>
      db
        .insertInto('tenant_oidc')
        .values({
          id: randomUUID(),
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
          idp_role: idpRole,
          renkei_role: renkeiRole,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.columns(['idp_role']).doUpdateSet({
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
  const encryptionKeyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
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
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok(Number(result.val.numUpdatedRows) > 0);
}

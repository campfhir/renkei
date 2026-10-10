import { encrypt, decrypt, loadKeyring } from '@renkei/crypto';
import { randomUUID } from 'crypto';
import { sql } from 'kysely';
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
   * connector audience rules. Absent means groups are not read at all:
   * nobody is in any group, and a connector scoped to an audience is open
   * to nobody. There is no conventional claim to assume.
   */
  groupsClaim?: string | null;
}

/** The claim-mapping half of the OIDC config: editable without the client secret. */
export interface TenantOidcClaims {
  roleClaim?: string | null;
  operatorIdpValue?: string | null;
  userIdpValue?: string | null;
  groupsClaim?: string | null;
}

/**
 * Configure the identity provider only if there is none.
 *
 * Resolves to false when a configuration already existed, leaving it
 * untouched. The first-run setup path needs this rather than
 * `setTenantOidc`: that one upserts, so two racing callers would both pass a
 * "not configured yet" check and the later write would silently replace the
 * earlier. Letting the database decide makes first-write-wins actually true:
 * `oidc_config` holds one row (a unique index on a constant), so the second
 * insert conflicts and does nothing.
 */
export async function createTenantOidcIfAbsent(
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
        .insertInto('oidc_config')
        .values({
          id: randomUUID(),
          issuer: oidc.issuer,
          client_id: oidc.clientId,
          client_secret: encrypt(oidc.clientSecret, encryptionKey),
          role_claim: oidc.roleClaim,
          operator_idp_value: oidc.operatorIdpValue || null,
          user_idp_value: oidc.userIdpValue || null,
          // Persisted here too: the first-run form collects it, and with the
          // column left NULL nobody would be in any group until an operator
          // re-saved the mapping.
          groups_claim: oidc.groupsClaim || null,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.expression(sql`(true)`).doNothing())
        .executeTakeFirst(),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  // A bigint literal would need an ES2020 target; Number() is safe for a count
  // that is only ever 0 or 1.
  return ok(Number(result.val?.numInsertedOrUpdatedRows ?? 0) > 0);
}

export async function setTenantOidc(
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
        .insertInto('oidc_config')
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
          oc.expression(sql`(true)`).doUpdateSet({
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
 * The identity provider configuration, client secret decrypted.
 */
export async function getTenantOidc(
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
        .selectFrom('oidc_config')
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
 * setTenantOidc needs the client secret and is what first-run setup uses;
 * changing which claim carries groups should not demand
 * re-entering a secret or re-running discovery.
 */
export async function getTenantOidcClaims(
): Promise<Result<TenantOidcClaims | null, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('oidc_config')
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

/** Update only the claim mappings; false when there is no OIDC row to update. */
export async function setTenantOidcClaims(
  claims: TenantOidcClaims
): Promise<Result<boolean, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const result = await wrapAsync(
    () =>
      dbResult.val
        .updateTable('oidc_config')
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

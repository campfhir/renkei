import { encrypt, decrypt, loadKeyring } from '@renkei/crypto';
import { randomUUID } from 'crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getDataStore, type OidcConfigInput } from '@renkei/db';
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

/** The row a save writes, the secret sealed. */
function configInput(oidc: TenantOidc, sealedSecret: string): OidcConfigInput {
  return {
    id: randomUUID(),
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    clientSecret: sealedSecret,
    roleClaim: oidc.roleClaim,
    operatorIdpValue: oidc.operatorIdpValue || null,
    userIdpValue: oidc.userIdpValue || null,
    // Persisted on first-run setup too: with it left NULL nobody would be
    // in any group until an operator re-saved the mapping.
    groupsClaim: oidc.groupsClaim || null,
  };
}

/**
 * Configure the identity provider only if there is none.
 *
 * Resolves to false when a configuration already existed, leaving it
 * untouched. The first-run setup path needs this rather than
 * `setTenantOidc`: that one upserts, so two racing callers would both pass a
 * "not configured yet" check and the later write would silently replace the
 * earlier. Letting the store decide makes first-write-wins actually true:
 * `oidc_config` holds one row (a unique index on a constant), so the second
 * insert conflicts and does nothing.
 */
export async function createTenantOidcIfAbsent(
  oidc: TenantOidc
): Promise<Result<boolean, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY'>> {
  const encryptionKeyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const input = configInput(oidc, encrypt(oidc.clientSecret, encryptionKeyResult.val));
  return wrapAsync(() => getDataStore().oidcConfig.createIfAbsent(input), 'DB_ERROR' as const);
}

export async function setTenantOidc(
  oidc: TenantOidc
): Promise<Result<void, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY'>> {
  const encryptionKeyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const input = configInput(oidc, encrypt(oidc.clientSecret, encryptionKeyResult.val));
  const result = await wrapAsync(() => getDataStore().oidcConfig.save(input), 'DB_ERROR' as const);
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
  const result = await wrapAsync(
    () => getDataStore().oidcConfig.setRoleMapping({ id: randomUUID(), idpRole, renkeiRole }),
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
  const rowResult = await wrapAsync(
    () => getDataStore().oidcConfig.getRoleMapping(idpRole),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;
  return ok(rowResult.val || null);
}

/**
 * The identity provider configuration, client secret decrypted.
 */
export async function getTenantOidc(): Promise<
  Result<TenantOidc | null, 'DB_ERROR' | 'INVALID_ENCRYPTION_KEY' | 'DECRYPTION_ERROR'>
> {
  const encryptionKeyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!encryptionKeyResult.ok) return err('INVALID_ENCRYPTION_KEY' as const);
  const encryptionKey = encryptionKeyResult.val;

  const rowResult = await wrapAsync(() => getDataStore().oidcConfig.get(), 'DB_ERROR' as const);
  if (!rowResult.ok) return rowResult;

  const row = rowResult.val;
  if (!row) return ok(null);

  const decryptedSecretResult = decrypt(row.clientSecret, encryptionKey);
  if (!decryptedSecretResult.ok) return err('DECRYPTION_ERROR' as const);

  return ok({
    issuer: row.issuer,
    clientId: row.clientId,
    clientSecret: decryptedSecretResult.val,
    roleClaim: row.roleClaim || undefined,
    operatorIdpValue: row.operatorIdpValue || undefined,
    userIdpValue: row.userIdpValue || undefined,
    groupsClaim: row.groupsClaim || undefined,
  });
}

/**
 * The claim mappings alone, for the admin settings page. The full
 * setTenantOidc needs the client secret and is what first-run setup uses;
 * changing which claim carries groups should not demand
 * re-entering a secret or re-running discovery.
 */
export async function getTenantOidcClaims(): Promise<Result<TenantOidcClaims | null, 'DB_ERROR'>> {
  const rowResult = await wrapAsync(() => getDataStore().oidcConfig.get(), 'DB_ERROR' as const);
  if (!rowResult.ok) return rowResult;
  const row = rowResult.val;
  if (!row) return ok(null);
  return ok({
    roleClaim: row.roleClaim,
    operatorIdpValue: row.operatorIdpValue,
    userIdpValue: row.userIdpValue,
    groupsClaim: row.groupsClaim,
  });
}

/**
 * The issuer and claim mappings, for the admin settings page; null before
 * first-run setup. No secret.
 */
export async function getTenantOidcSummary(): Promise<
  Result<(TenantOidcClaims & { issuer: string }) | null, 'DB_ERROR'>
> {
  const rowResult = await wrapAsync(() => getDataStore().oidcConfig.get(), 'DB_ERROR' as const);
  if (!rowResult.ok) return rowResult;
  const row = rowResult.val;
  if (!row) return ok(null);
  return ok({
    issuer: row.issuer,
    roleClaim: row.roleClaim,
    operatorIdpValue: row.operatorIdpValue,
    userIdpValue: row.userIdpValue,
    groupsClaim: row.groupsClaim,
  });
}

/** Update only the claim mappings; false when there is no OIDC row to update. */
export async function setTenantOidcClaims(
  claims: TenantOidcClaims
): Promise<Result<boolean, 'DB_ERROR'>> {
  return wrapAsync(
    () =>
      getDataStore().oidcConfig.updateClaims({
        roleClaim: claims.roleClaim || null,
        operatorIdpValue: claims.operatorIdpValue || null,
        userIdpValue: claims.userIdpValue || null,
        groupsClaim: claims.groupsClaim || null,
      }),
    'DB_ERROR' as const
  );
}

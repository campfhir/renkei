/**
 * The provider-agnostic grant store: encrypted at rest, subject-bound,
 * keyed (tenant, provider, provider account). Provider-specific identity
 * lives in the metadata jsonb and is round-tripped untouched.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { encrypt, decrypt } from '@renkei/crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { NewProviderGrant, ProviderGrant } from './types';

function readMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== 'object' || metadata === null) return {};
  return { ...metadata };
}

export async function setGrant(
  provider: string,
  tenantId: string,
  grant: NewProviderGrant,
  encryptionKey: Buffer
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const encryptedAccessToken = encrypt(grant.accessToken, encryptionKey);
  const encryptedRefreshToken = encrypt(grant.refreshToken, encryptionKey);
  const metadata = JSON.stringify(grant.metadata);

  const result = await wrapAsync(
    () =>
      db
        .insertInto('provider_grants')
        .values({
          tenant_id: tenantId,
          provider,
          provider_account_id: grant.accountId,
          client_id: grant.clientId,
          display_name: grant.displayName || grant.accountId,
          subject: grant.subject,
          encrypted_access_token: encryptedAccessToken,
          encrypted_refresh_token: encryptedRefreshToken,
          expires_at: grant.expiresAt,
          requested_scopes: grant.requestedScopes,
          granted_scopes: grant.grantedScopes,
          metadata,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'provider', 'provider_account_id']).doUpdateSet({
            encrypted_access_token: encryptedAccessToken,
            // A repeat authorization while a grant already exists can come
            // back with no refresh_token at all (observed on Bitbucket,
            // which only reissues one on a genuinely fresh consent) — the
            // caller then has nothing but '' to offer here. Trusting that
            // blindly would overwrite a refresh token that still works,
            // and the breakage wouldn't surface until the access token
            // from *this* exchange expires and refresh starts failing with
            // invalid_grant, deleting the grant outright. Keep the stored
            // token when the new one is empty.
            encrypted_refresh_token: grant.refreshToken
              ? encryptedRefreshToken
              : sql`provider_grants.encrypted_refresh_token`,
            expires_at: grant.expiresAt,
            // Re-stamped on reconnect: the old row's scopes describe the old
            // authorization, and keeping them once hid a narrowed re-consent.
            requested_scopes: grant.requestedScopes,
            granted_scopes: grant.grantedScopes,
            metadata,
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

export async function getGrant(
  provider: string,
  tenantId: string,
  accountId: string,
  encryptionKey: Buffer
): Promise<Result<ProviderGrant | null, 'DB_ERROR' | 'DECRYPTION_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

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
          'requested_scopes',
          'granted_scopes',
          'subject',
        ])
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', provider)
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

  return ok({
    provider,
    accountId: row.provider_account_id,
    subject: row.subject,
    clientId: row.client_id,
    displayName: row.display_name || '',
    accessToken: accessTokenResult.val,
    refreshToken: refreshTokenResult.val,
    expiresAt: row.expires_at.toISOString(),
    requestedScopes: row.requested_scopes,
    grantedScopes: row.granted_scopes,
    metadata: readMetadata(row.metadata),
  });
}

export async function deleteGrant(
  provider: string,
  tenantId: string,
  accountId: string
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const result = await wrapAsync(
    () =>
      dbResult.val
        .deleteFrom('provider_grants')
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', provider)
        .where('provider_account_id', '=', accountId)
        .execute(),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  return ok();
}

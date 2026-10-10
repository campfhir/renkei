/**
 * The provider-agnostic grant store: encrypted at rest, subject-bound,
 * keyed (tenant, provider, provider account). Provider-specific identity
 * lives in the metadata jsonb and is round-tripped untouched.
 *
 * Tokens are sealed under their OWNER's key (`uenc1:`, @renkei/user-keys,
 * docs/user-encryption-keys-design.md): a person's credential under a key
 * derived for that person, never shared and never under a deployment-wide
 * key. A grant row is therefore unusable without a subject — the owner is
 * the key — and a row from before per-user keys opens only once the
 * rekey sweep has moved it (`pnpm rekey-chats --connectors`).
 */

import { sql, type Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { openForSubject, sealForSubject } from '@renkei/user-keys';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { NewProviderGrant, ProviderGrant } from './types';

function readMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== 'object' || metadata === null) return {};
  return { ...metadata };
}

/** A token as stored: under its owner's key. */
export async function sealGrantToken(
  db: Kysely<DB>,
  subject: string,
  token: string
): Promise<Result<string, 'SEAL_ERROR'>> {
  const sealed = await sealForSubject(db, subject, token);
  if (!sealed.ok) return err('SEAL_ERROR' as const, { message: sealed.err.type });
  return ok(sealed.val);
}

/**
 * The stored token opened under its owner's key. A row with no subject
 * has no key and cannot be opened; a KEY_LOCKED owner (their own key,
 * not unlocked) reads the same way to a caller — the grant is not usable
 * right now.
 */
async function openGrantToken(
  db: Kysely<DB>,
  subject: string | null,
  stored: string
): Promise<Result<string, 'DECRYPTION_ERROR'>> {
  if (!subject) {
    return err('DECRYPTION_ERROR' as const, { message: 'grant has no owner, so no key' });
  }
  const opened = await openForSubject(db, subject, stored);
  if (!opened.ok) return err('DECRYPTION_ERROR' as const, { message: opened.err.type });
  return ok(opened.val);
}

export async function setGrant(
  provider: string,
  grant: NewProviderGrant
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const sealedAccess = await sealGrantToken(db, grant.subject, grant.accessToken);
  const sealedRefresh = await sealGrantToken(db, grant.subject, grant.refreshToken);
  if (!sealedAccess.ok || !sealedRefresh.ok) return err('DB_ERROR' as const);
  const encryptedAccessToken = sealedAccess.val;
  const encryptedRefreshToken = sealedRefresh.val;
  const metadata = JSON.stringify(grant.metadata);

  const result = await wrapAsync(
    () =>
      db
        .insertInto('provider_grants')
        .values({
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
          oc.columns(['provider', 'provider_account_id']).doUpdateSet({
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
  accountId: string
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
        .where('provider', '=', provider)
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );

  if (!rowResult.ok) return rowResult;

  const row = rowResult.val;
  if (!row) return ok(null);

  const accessTokenResult = await openGrantToken(
    db,
    row.subject,
    row.encrypted_access_token
  );
  if (!accessTokenResult.ok) return err('DECRYPTION_ERROR' as const);

  const refreshTokenResult = await openGrantToken(
    db,
    row.subject,
    row.encrypted_refresh_token
  );
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
  accountId: string
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const result = await wrapAsync(
    () =>
      dbResult.val
        .deleteFrom('provider_grants')
        .where('provider', '=', provider)
        .where('provider_account_id', '=', accountId)
        .execute(),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  return ok();
}

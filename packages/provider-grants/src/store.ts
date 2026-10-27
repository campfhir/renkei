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

import { getDataStore } from '@renkei/db';
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
  subject: string,
  token: string
): Promise<Result<string, 'SEAL_ERROR'>> {
  const sealed = await sealForSubject(subject, token);
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
  subject: string | null,
  stored: string
): Promise<Result<string, 'DECRYPTION_ERROR'>> {
  if (!subject) {
    return err('DECRYPTION_ERROR' as const, { message: 'grant has no owner, so no key' });
  }
  const opened = await openForSubject(subject, stored);
  if (!opened.ok) return err('DECRYPTION_ERROR' as const, { message: opened.err.type });
  return ok(opened.val);
}

export async function setGrant(
  provider: string,
  grant: NewProviderGrant
): Promise<Result<void, 'DB_ERROR'>> {
  const sealedAccess = await wrapAsync(
    () => sealGrantToken(grant.subject, grant.accessToken),
    'DB_ERROR' as const
  );
  const sealedRefresh = await wrapAsync(
    () => sealGrantToken(grant.subject, grant.refreshToken),
    'DB_ERROR' as const
  );
  if (!sealedAccess.ok || !sealedAccess.val.ok || !sealedRefresh.ok || !sealedRefresh.val.ok) {
    return err('DB_ERROR' as const);
  }
  const encryptedAccessToken = sealedAccess.val.val;
  const encryptedRefreshToken = sealedRefresh.val.val;

  const result = await wrapAsync(
    () =>
      getDataStore().providerGrants.upsertSealed(provider, {
        accountId: grant.accountId,
        clientId: grant.clientId,
        displayName: grant.displayName || grant.accountId,
        subject: grant.subject,
        encryptedAccessToken,
        encryptedRefreshToken,
        // A repeat authorization while a grant already exists can come
        // back with no refresh_token at all (observed on Bitbucket,
        // which only reissues one on a genuinely fresh consent) — the
        // caller then has nothing but '' to offer here. Trusting that
        // blindly would overwrite a refresh token that still works,
        // and the breakage wouldn't surface until the access token
        // from *this* exchange expires and refresh starts failing with
        // invalid_grant, deleting the grant outright. Keep the stored
        // token when the new one is empty.
        keepStoredRefreshToken: !grant.refreshToken,
        expiresAt: new Date(grant.expiresAt),
        // Re-stamped on reconnect: the old row's scopes describe the old
        // authorization, and keeping them once hid a narrowed re-consent.
        requestedScopes: grant.requestedScopes,
        grantedScopes: grant.grantedScopes,
        metadata: grant.metadata,
      }),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  return ok();
}

export async function getGrant(
  provider: string,
  accountId: string
): Promise<Result<ProviderGrant | null, 'DB_ERROR' | 'DECRYPTION_ERROR'>> {
  const rowResult = await wrapAsync(
    () => getDataStore().providerGrants.findSealed(provider, accountId),
    'DB_ERROR' as const
  );

  if (!rowResult.ok) return rowResult;

  const row = rowResult.val;
  if (!row) return ok(null);

  const accessTokenResult = await openGrantToken(row.subject, row.encryptedAccessToken);
  if (!accessTokenResult.ok) return err('DECRYPTION_ERROR' as const);

  const refreshTokenResult = await openGrantToken(row.subject, row.encryptedRefreshToken);
  if (!refreshTokenResult.ok) return err('DECRYPTION_ERROR' as const);

  return ok({
    provider,
    accountId: row.accountId,
    subject: row.subject,
    clientId: row.clientId,
    displayName: row.displayName || '',
    accessToken: accessTokenResult.val,
    refreshToken: refreshTokenResult.val,
    expiresAt: row.expiresAt.toISOString(),
    requestedScopes: row.requestedScopes,
    grantedScopes: row.grantedScopes,
    metadata: readMetadata(row.metadata),
  });
}

export async function deleteGrant(
  provider: string,
  accountId: string
): Promise<Result<void, 'DB_ERROR'>> {
  const result = await wrapAsync(
    () => getDataStore().providerGrants.delete(provider, accountId),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  return ok();
}

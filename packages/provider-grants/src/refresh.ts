/**
 * Cross-process token refresh, provider-agnostic.
 *
 * The orchestration is: take the distributed lock (or wait out whoever holds
 * it and reuse their result), decrypt the refresh token, hand it to the
 * provider adapter, persist what comes back. Only a GRANT_REVOKED verdict
 * from the adapter deletes the grant — every other failure is ours to fix,
 * and deleting there would destroy a working authorization and force a
 * pointless re-consent.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getGrant, deleteGrant, sealGrantToken } from './store';
import { scopesFromAccessToken } from './token-claims';
import { silentLogger } from './types';
import type { GrantLogger, ProviderAdapter, RefreshedTokens, RefreshError } from './types';

/** A lock older than this belongs to a crashed process and is reclaimed. */
const STALE_LOCK_MS = 5 * 60 * 1000;

async function acquireRefreshLock(
  db: Kysely<DB>,
  provider: string,
  accountId: string
): Promise<boolean> {
  try {
    await db
      .insertInto('provider_refresh_locks')
      .values({ provider, account_id: accountId, locked_at: new Date() })
      .execute();
    return true;
  } catch {
    return false;
  }
}

async function releaseRefreshLock(
  db: Kysely<DB>,
  provider: string,
  accountId: string
): Promise<void> {
  try {
    await db
      .deleteFrom('provider_refresh_locks')
      .where('provider', '=', provider)
      .where('account_id', '=', accountId)
      .execute();
  } catch {
    // Ignore errors on release
  }
}

/** Poll with exponential backoff until the holder finishes, max ~10 seconds. */
async function waitForRefreshLock(
  db: Kysely<DB>,
  provider: string,
  accountId: string
): Promise<void> {
  let attempts = 0;
  const maxAttempts = 20;

  while (attempts < maxAttempts) {
    const lock = await db
      .selectFrom('provider_refresh_locks')
      .select('locked_at')
      .where('provider', '=', provider)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!lock) return;

    if (Date.now() - lock.locked_at.getTime() > STALE_LOCK_MS) {
      await releaseRefreshLock(db, provider, accountId);
      return;
    }

    const delayMs = Math.min(50 * Math.pow(2, attempts), 500);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempts++;
  }
}

export async function refreshGrantTokens(
  adapter: ProviderAdapter,
  accountId: string,
  logger: GrantLogger = silentLogger
): Promise<Result<RefreshedTokens, RefreshError>> {
  const provider = adapter.provider;
  logger.debug('[Refresh] Starting token refresh', { provider, accountId });

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('[Refresh] Database unavailable', { provider, accountId });
    return err('REFRESH_FAILED' as const);
  }
  const db = dbResult.val;

  try {
    const lockAcquired = await acquireRefreshLock(db, provider, accountId);
    if (!lockAcquired) {
      logger.debug('[Refresh] Lock not acquired, waiting for other process', {
        provider,
        accountId,
      });
      await waitForRefreshLock(db, provider, accountId);
      // The other process may have refreshed already — reuse its result.
      const refetch = await getGrant(provider, accountId);
      if (refetch.ok && refetch.val) {
        logger.debug('[Refresh] Using refreshed token from other process', {
          provider,
          accountId,
        });
        return ok({
          accessToken: refetch.val.accessToken,
          refreshToken: refetch.val.refreshToken,
          expiresAt: new Date(refetch.val.expiresAt),
        });
      }
      logger.debug('[Refresh] Re-fetch failed, proceeding with refresh', {
        provider,
        accountId,
      });
    }

    const grantResult = await getGrant(provider, accountId);
    if (!grantResult.ok || !grantResult.val) {
      logger.error('[Refresh] No usable grant found', { provider, accountId });
      return err('REFRESH_FAILED' as const);
    }
    const grant = grantResult.val;

    const refreshed = await adapter.refreshTokens(grant.clientId, grant.refreshToken);
    if (!refreshed.ok) {
      if (refreshed.err.type === 'GRANT_REVOKED') {
        logger.warn('[Refresh] Refresh token rejected by provider, deleting grant', {
          provider,
          accountId,
        });
        await deleteGrant(provider, accountId);
        return err('GRANT_REVOKED' as const);
      }
      // The kind and the provider's own words: without them this line
      // cannot distinguish an expired refresh token from a network blip
      // from a misconfigured client, which are three different fixes.
      logger.error('[Refresh] Provider refresh failed: {kind} {message}', {
        provider,
        accountId,
        kind: refreshed.err.type,
        message:
          typeof refreshed.err.message === 'string' ? refreshed.err.message.slice(0, 300) : '',
      });
      return err('REFRESH_FAILED' as const);
    }

    const { accessToken, refreshToken, expiresAt } = refreshed.val;

    // A refresh mints a new token, so granted_scopes is re-derived from its
    // claims — a provider quietly narrowing scopes on refresh becomes visible
    // in the row instead of only in a downstream 401. Opaque tokens decode to
    // null and leave the column untouched (unknown ≠ revoked).
    const grantedScopes = scopesFromAccessToken(accessToken);

    // Sealed under the owner's key (store.ts). A grant that opened has an
    // owner, so the subject is there to seal for.
    if (!grant.subject) return err('REFRESH_FAILED' as const);
    const sealedAccess = await sealGrantToken(db, grant.subject, accessToken);
    const sealedRefresh = await sealGrantToken(db, grant.subject, refreshToken);
    if (!sealedAccess.ok || !sealedRefresh.ok) {
      logger.error('[Refresh] Could not seal refreshed tokens', { provider, accountId });
      return err('REFRESH_FAILED' as const);
    }
    const updateResult = await wrapAsync(
      () =>
        db
          .updateTable('provider_grants')
          .set({
            encrypted_access_token: sealedAccess.val,
            encrypted_refresh_token: sealedRefresh.val,
            expires_at: expiresAt,
            updated_at: new Date(),
            ...(grantedScopes ? { granted_scopes: grantedScopes } : {}),
          })
          .where('provider', '=', provider)
          .where('provider_account_id', '=', accountId)
          .execute(),
      'REFRESH_FAILED' as const
    );

    if (!updateResult.ok) {
      logger.error('[Refresh] Failed to persist refreshed tokens', {
        provider,
        accountId,
      });
      return updateResult;
    }

    logger.debug('[Refresh] Token refreshed successfully', {
      provider,
      accountId,
      expiresAt: expiresAt.toISOString(),
    });
    return ok({ accessToken, refreshToken, expiresAt });
  } catch (error) {
    logger.error('[Refresh] Unexpected error during refresh', {
      provider,
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err('REFRESH_FAILED' as const);
  } finally {
    await releaseRefreshLock(db, provider, accountId);
  }
}

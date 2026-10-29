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

import { getDataStore } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getGrant, deleteGrant, sealGrantToken } from './store';
import { scopesFromAccessToken } from './token-claims';
import { silentLogger } from './types';
import type { GrantLogger, ProviderAdapter, RefreshedTokens, RefreshError } from './types';

/** A lock older than this belongs to a crashed process and is reclaimed. */
const STALE_LOCK_MS = 5 * 60 * 1000;

async function acquireRefreshLock(
  provider: string,
  accountId: string,
  logger: GrantLogger
): Promise<boolean> {
  try {
    return await getDataStore().providerGrants.acquireRefreshLock(provider, accountId, new Date());
  } catch (error) {
    logger.warn('[Refresh] Could not take the refresh lock: {error}', {
      provider,
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function releaseRefreshLock(
  provider: string,
  accountId: string,
  logger: GrantLogger
): Promise<void> {
  try {
    await getDataStore().providerGrants.releaseRefreshLock(provider, accountId);
  } catch (error) {
    // Not fatal — a held lock goes stale and is reclaimed — but worth seeing.
    logger.warn('[Refresh] Could not release the refresh lock: {error}', {
      provider,
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Poll with exponential backoff until the holder finishes, max ~10 seconds. */
async function waitForRefreshLock(
  provider: string,
  accountId: string,
  logger: GrantLogger
): Promise<void> {
  let attempts = 0;
  const maxAttempts = 20;

  while (attempts < maxAttempts) {
    const lockedAt = await getDataStore().providerGrants.findRefreshLock(provider, accountId);

    if (!lockedAt) return;

    if (Date.now() - lockedAt.getTime() > STALE_LOCK_MS) {
      await releaseRefreshLock(provider, accountId, logger);
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

  try {
    const lockAcquired = await acquireRefreshLock(provider, accountId, logger);
    if (!lockAcquired) {
      logger.debug('[Refresh] Lock not acquired, waiting for other process', {
        provider,
        accountId,
      });
      await waitForRefreshLock(provider, accountId, logger);
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
      logger.error('[Refresh] No usable grant found: {error}', {
        provider,
        accountId,
        error: grantResult.ok
          ? 'no grant stored'
          : `${grantResult.err.type} ${grantResult.err.message ?? ''}`.trim(),
      });
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
    if (!grant.subject) {
      logger.error('[Refresh] Grant has no owner to seal the refreshed tokens for', {
        provider,
        accountId,
      });
      return err('REFRESH_FAILED' as const);
    }
    const sealedAccess = await sealGrantToken(grant.subject, accessToken);
    const sealedRefresh = await sealGrantToken(grant.subject, refreshToken);
    if (!sealedAccess.ok || !sealedRefresh.ok) {
      logger.error('[Refresh] Could not seal refreshed tokens: {error}', {
        provider,
        accountId,
        error: !sealedAccess.ok
          ? sealedAccess.err.message
          : !sealedRefresh.ok
            ? sealedRefresh.err.message
            : '',
      });
      return err('REFRESH_FAILED' as const);
    }
    const updateResult = await wrapAsync(
      () =>
        getDataStore().providerGrants.updateSealedTokens(provider, accountId, {
          encryptedAccessToken: sealedAccess.val,
          encryptedRefreshToken: sealedRefresh.val,
          expiresAt,
          grantedScopes,
        }),
      'REFRESH_FAILED' as const
    );

    if (!updateResult.ok) {
      logger.error('[Refresh] Failed to persist refreshed tokens: {error}', {
        provider,
        accountId,
        error: updateResult.err.message,
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
    await releaseRefreshLock(provider, accountId, logger);
  }
}

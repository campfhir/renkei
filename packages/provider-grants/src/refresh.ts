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
import { encrypt } from '@renkei/crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getGrant, deleteGrant } from './store';
import { scopesFromAccessToken } from './token-claims';
import { silentLogger } from './types';
import type { GrantLogger, ProviderAdapter, RefreshedTokens, RefreshError } from './types';

/** A lock older than this belongs to a crashed process and is reclaimed. */
const STALE_LOCK_MS = 5 * 60 * 1000;

async function acquireRefreshLock(
  db: Kysely<DB>,
  provider: string,
  tenantId: string,
  accountId: string
): Promise<boolean> {
  try {
    await db
      .insertInto('provider_refresh_locks')
      .values({ tenant_id: tenantId, provider, account_id: accountId, locked_at: new Date() })
      .execute();
    return true;
  } catch {
    return false;
  }
}

async function releaseRefreshLock(
  db: Kysely<DB>,
  provider: string,
  tenantId: string,
  accountId: string
): Promise<void> {
  try {
    await db
      .deleteFrom('provider_refresh_locks')
      .where('tenant_id', '=', tenantId)
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
  tenantId: string,
  accountId: string
): Promise<void> {
  let attempts = 0;
  const maxAttempts = 20;

  while (attempts < maxAttempts) {
    const lock = await db
      .selectFrom('provider_refresh_locks')
      .select('locked_at')
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', provider)
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    if (!lock) return;

    if (Date.now() - lock.locked_at.getTime() > STALE_LOCK_MS) {
      await releaseRefreshLock(db, provider, tenantId, accountId);
      return;
    }

    const delayMs = Math.min(50 * Math.pow(2, attempts), 500);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempts++;
  }
}

export async function refreshGrantTokens(
  adapter: ProviderAdapter,
  tenantId: string,
  accountId: string,
  encryptionKey: Buffer,
  logger: GrantLogger = silentLogger
): Promise<Result<RefreshedTokens, RefreshError>> {
  const provider = adapter.provider;
  logger.info('[Refresh] Starting token refresh', { provider, tenantId, accountId });

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('[Refresh] Database unavailable', { provider, tenantId, accountId });
    return err('REFRESH_FAILED' as const);
  }
  const db = dbResult.val;

  try {
    const lockAcquired = await acquireRefreshLock(db, provider, tenantId, accountId);
    if (!lockAcquired) {
      logger.debug('[Refresh] Lock not acquired, waiting for other process', {
        provider,
        tenantId,
        accountId,
      });
      await waitForRefreshLock(db, provider, tenantId, accountId);
      // The other process may have refreshed already — reuse its result.
      const refetch = await getGrant(provider, tenantId, accountId, encryptionKey);
      if (refetch.ok && refetch.val) {
        logger.info('[Refresh] Using refreshed token from other process', {
          provider,
          tenantId,
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
        tenantId,
        accountId,
      });
    }

    const grantResult = await getGrant(provider, tenantId, accountId, encryptionKey);
    if (!grantResult.ok || !grantResult.val) {
      logger.error('[Refresh] No usable grant found', { provider, tenantId, accountId });
      return err('REFRESH_FAILED' as const);
    }
    const grant = grantResult.val;

    const refreshed = await adapter.refreshTokens(grant.clientId, grant.refreshToken);
    if (!refreshed.ok) {
      if (refreshed.err.type === 'GRANT_REVOKED') {
        logger.warn('[Refresh] Refresh token rejected by provider, deleting grant', {
          provider,
          tenantId,
          accountId,
        });
        await deleteGrant(provider, tenantId, accountId);
        return err('GRANT_REVOKED' as const);
      }
      logger.error('[Refresh] Provider refresh failed', { provider, tenantId, accountId });
      return err('REFRESH_FAILED' as const);
    }

    const { accessToken, refreshToken, expiresAt } = refreshed.val;

    // A refresh mints a new token, so granted_scopes is re-derived from its
    // claims — a provider quietly narrowing scopes on refresh becomes visible
    // in the row instead of only in a downstream 401. Opaque tokens decode to
    // null and leave the column untouched (unknown ≠ revoked).
    const grantedScopes = scopesFromAccessToken(accessToken);

    const updateResult = await wrapAsync(
      () =>
        db
          .updateTable('provider_grants')
          .set({
            encrypted_access_token: encrypt(accessToken, encryptionKey),
            encrypted_refresh_token: encrypt(refreshToken, encryptionKey),
            expires_at: expiresAt,
            updated_at: new Date(),
            ...(grantedScopes ? { granted_scopes: grantedScopes } : {}),
          })
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', provider)
          .where('provider_account_id', '=', accountId)
          .execute(),
      'REFRESH_FAILED' as const
    );

    if (!updateResult.ok) {
      logger.error('[Refresh] Failed to persist refreshed tokens', {
        provider,
        tenantId,
        accountId,
      });
      return updateResult;
    }

    logger.info('[Refresh] Token refreshed successfully', {
      provider,
      tenantId,
      accountId,
      expiresAt: expiresAt.toISOString(),
    });
    return ok({ accessToken, refreshToken, expiresAt });
  } catch (error) {
    logger.error('[Refresh] Unexpected error during refresh', {
      provider,
      tenantId,
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err('REFRESH_FAILED' as const);
  } finally {
    await releaseRefreshLock(db, provider, tenantId, accountId);
  }
}

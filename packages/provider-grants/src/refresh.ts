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

import { actorFields, describeAccountActor, getDataStore, type ActorFields } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getGrant, deleteGrant, sealGrantToken } from './store';
import { scopesFromAccessToken } from './token-claims';
import { silentLogger } from './types';
import type { GrantLogger, ProviderAdapter, RefreshedTokens, RefreshError } from './types';

/** A lock older than this belongs to a crashed process and is reclaimed. */
const STALE_LOCK_MS = 5 * 60 * 1000;

/**
 * `provider_grants.provider` keys → the names people know them by, for the
 * log lines (the web app's provider-labels.ts says the same; a package
 * cannot import it). An unknown key logs as itself.
 */
const PROVIDER_LABELS: Record<string, string> = {
  atlassian: 'Jira',
  'atlassian-jsm': 'Jira Service Management',
  'atlassian-confluence': 'Confluence',
  'atlassian-bitbucket': 'Bitbucket',
  'atlassian-admin': 'Jira Administration',
  microsoft: 'Microsoft 365',
  'entra-developer': 'Entra Developer',
  webex: 'WebEx',
  zoom: 'Zoom',
  github: 'GitHub',
  onbase: 'OnBase',
  'onbase-admin': 'OnBase Administration',
  salesforce: 'Salesforce',
};

/** What every line about one grant's refresh carries: whose grant, to which provider. */
interface RefreshContext extends ActorFields {
  provider: string;
  providerName: string;
  accountId: string;
  /** A GrantLogger's context is a plain record; the fields above are what it holds. */
  [key: string]: unknown;
}

async function refreshContext(provider: string, accountId: string): Promise<RefreshContext> {
  return {
    ...actorFields(await describeAccountActor(accountId)),
    provider,
    providerName: PROVIDER_LABELS[provider] ?? provider,
    accountId,
  };
}

async function acquireRefreshLock(about: RefreshContext, logger: GrantLogger): Promise<boolean> {
  try {
    return await getDataStore().providerGrants.acquireRefreshLock(
      about.provider,
      about.accountId,
      new Date()
    );
  } catch (error) {
    logger.warn(
      "the refresh lock for {actor}'s {providerName} grant could not be taken; waiting for whoever holds it, then refreshing anyway: {error}",
      {
        ...about,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return false;
  }
}

async function releaseRefreshLock(about: RefreshContext, logger: GrantLogger): Promise<void> {
  try {
    await getDataStore().providerGrants.releaseRefreshLock(about.provider, about.accountId);
  } catch (error) {
    // Not fatal — a held lock goes stale and is reclaimed — but worth seeing.
    logger.warn(
      "the refresh lock for {actor}'s {providerName} grant could not be released; it goes stale and is reclaimed in five minutes: {error}",
      {
        ...about,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/** Poll with exponential backoff until the holder finishes, max ~10 seconds. */
async function waitForRefreshLock(about: RefreshContext, logger: GrantLogger): Promise<void> {
  let attempts = 0;
  const maxAttempts = 20;

  while (attempts < maxAttempts) {
    const lockedAt = await getDataStore().providerGrants.findRefreshLock(
      about.provider,
      about.accountId
    );

    if (!lockedAt) return;

    if (Date.now() - lockedAt.getTime() > STALE_LOCK_MS) {
      await releaseRefreshLock(about, logger);
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
  // The owner is named from the grant row (its subject) once, up front:
  // every line below, the lock lines included, is about one person's
  // connection to one provider.
  const about = await refreshContext(provider, accountId);
  logger.debug("refreshing {actor}'s {providerName} tokens", about);

  try {
    const lockAcquired = await acquireRefreshLock(about, logger);
    if (!lockAcquired) {
      logger.debug(
        "another process is refreshing {actor}'s {providerName} tokens; waiting for it to finish",
        about
      );
      await waitForRefreshLock(about, logger);
      // The other process may have refreshed already — reuse its result.
      const refetch = await getGrant(provider, accountId);
      if (refetch.ok && refetch.val) {
        logger.debug(
          "{actor}'s {providerName} tokens were refreshed by another process meanwhile; reusing them",
          about
        );
        return ok({
          accessToken: refetch.val.accessToken,
          refreshToken: refetch.val.refreshToken,
          expiresAt: new Date(refetch.val.expiresAt),
        });
      }
      logger.debug(
        "{actor}'s {providerName} grant could not be re-read after waiting; refreshing it here",
        about
      );
    }

    const grantResult = await getGrant(provider, accountId);
    if (!grantResult.ok || !grantResult.val) {
      logger.error(
        "{actor}'s {providerName} tokens were not refreshed: no usable grant is stored: {error}",
        {
          ...about,
          error: grantResult.ok
            ? 'no grant stored'
            : `${grantResult.err.type} ${grantResult.err.message ?? ''}`.trim(),
        }
      );
      return err('REFRESH_FAILED' as const);
    }
    const grant = grantResult.val;

    const refreshed = await adapter.refreshTokens(grant.clientId, grant.refreshToken);
    if (!refreshed.ok) {
      if (refreshed.err.type === 'GRANT_REVOKED') {
        logger.warn(
          "{providerName} rejected {actor}'s refresh token; the grant was deleted and they must connect {providerName} again",
          about
        );
        await deleteGrant(provider, accountId);
        return err('GRANT_REVOKED' as const);
      }
      // The kind and the provider's own words: without them this line
      // cannot distinguish an expired refresh token from a network blip
      // from a misconfigured client, which are three different fixes.
      logger.error(
        "{providerName} did not refresh {actor}'s tokens ({kind}); the stored tokens are unchanged: {error}",
        {
          ...about,
          kind: refreshed.err.type,
          error:
            typeof refreshed.err.message === 'string' ? refreshed.err.message.slice(0, 300) : '',
        }
      );
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
      logger.error(
        "{providerName} refreshed {actor}'s tokens, but the grant has no owner to seal them for; nothing was persisted",
        about
      );
      return err('REFRESH_FAILED' as const);
    }
    const sealedAccess = await sealGrantToken(grant.subject, accessToken);
    const sealedRefresh = await sealGrantToken(grant.subject, refreshToken);
    if (!sealedAccess.ok || !sealedRefresh.ok) {
      logger.error(
        "{actor}'s refreshed {providerName} tokens could not be sealed; nothing was persisted: {error}",
        {
          ...about,
          error: !sealedAccess.ok
            ? sealedAccess.err.message
            : !sealedRefresh.ok
              ? sealedRefresh.err.message
              : '',
        }
      );
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
      logger.error(
        "{actor}'s refreshed {providerName} tokens could not be persisted; the next call refreshes again: {error}",
        {
          ...about,
          error: updateResult.err.message,
        }
      );
      return updateResult;
    }

    logger.debug(
      "{actor}'s {providerName} tokens were refreshed and persisted; they expire at {expiresAt}",
      {
        ...about,
        expiresAt: expiresAt.toISOString(),
      }
    );
    return ok({ accessToken, refreshToken, expiresAt });
  } catch (error) {
    logger.error(
      "refreshing {actor}'s {providerName} tokens threw; nothing was persisted: {error}",
      {
        ...about,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return err('REFRESH_FAILED' as const);
  } finally {
    await releaseRefreshLock(about, logger);
  }
}

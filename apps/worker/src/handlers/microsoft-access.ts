/**
 * Per-grant Microsoft access for the worker: describe the grant at the
 * delegate, hand back its fetcher plus the identity facts (upn, effective
 * scopes, indexing preferences) ingestion builds refIds and subscription
 * sets from.
 *
 * The worker holds no token (docs/delegate-key-design.md, "Phase 1 as
 * built"): the fetcher rides the grant at the delegate, which attaches the
 * credential, refreshes it when due and retries a 401 once.
 *
 * Throws with operator-readable reasons — a missing grant or an
 * unreachable delegate surfaces on the dead-lettered event's last_error,
 * which is where an operator will look.
 */

import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { MICROSOFT, outlookIndexingOf, type OutlookIndexingPrefs } from '@renkei/provider-grants';

export interface MicrosoftAccess {
  /** The grant's fetcher; the delegate behind it supplies the credential. */
  auth: AuthedFetch;
  accountId: string;
  /** Lowercased — the refId owner segment and purge prefix. */
  upn: string;
  /** granted ?? requested: what tools and subscriptions may cover. */
  scopes: string[];
  /** What the user opted into indexing; scope ∧ preference gates each category. */
  indexing: OutlookIndexingPrefs;
}

export async function resolveMicrosoftAccess(
  accountId: string
): Promise<MicrosoftAccess> {
  const grant = { provider: MICROSOFT, accountId };
  const described = await delegateGrants().describe(grant);
  if (!described.ok) {
    throw new Error(
      described.err.type === 'NO_GRANT'
        ? `no microsoft grant for account ${accountId} (disconnected?)`
        : `could not read microsoft grant for ${accountId}: ${described.err.type}`
    );
  }
  const { metadata, grantedScopes, requestedScopes } = described.val;

  const upn = typeof metadata.upn === 'string' ? metadata.upn.toLowerCase() : '';
  if (!upn) throw new Error(`microsoft grant for ${accountId} carries no upn`);

  return {
    auth: grantFetch(grant),
    accountId,
    upn,
    scopes: grantedScopes ?? requestedScopes,
    indexing: outlookIndexingOf(metadata),
  };
}

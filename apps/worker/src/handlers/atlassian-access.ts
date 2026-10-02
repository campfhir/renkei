/**
 * Per-grant Atlassian access for the worker, for both the Jira and
 * Confluence apps — describe the grant at the delegate, hand back its
 * fetcher plus the cloud id every gateway URL needs.
 *
 * The worker holds no token (docs/delegate-key-design.md, "Phase 1 as
 * built"): the fetcher rides the grant at the delegate, which attaches the
 * credential, refreshes it when due and retries a 401 once. That is why
 * the proactive refresh this file used to do is gone — a sweep still has
 * no user to retry for, but the delegate retries for it.
 *
 * Throws with operator-readable reasons — a missing grant or an
 * unreachable delegate surfaces on the dead-lettered event's last_error,
 * which is where an operator will look.
 */

import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { readAtlassianMetadata } from '@renkei/provider-grants';

export interface AtlassianAccess {
  /** The grant's fetcher; the delegate behind it supplies the credential. */
  auth: AuthedFetch;
  accountId: string;
  /** The Atlassian site — every gateway path is /ex/{product}/{cloudId}/… */
  cloudId: string;
  /**
   * The site's own address, e.g. https://acme.atlassian.net. Carried so
   * indexed content can record a link a person can actually open — a
   * cloudId is a routing detail, not somewhere to click.
   */
  siteUrl: string;
}

/**
 * @param provider The grant provider key — ATLASSIAN for Jira,
 *   ATLASSIAN_CONFLUENCE for Confluence. Each app has its own grant rows.
 */
export async function resolveAtlassianAccess(
  tenantId: string,
  accountId: string,
  provider: string
): Promise<AtlassianAccess> {
  const grant = { tenantId, provider, accountId };
  const described = await delegateGrants().describe(grant);
  if (!described.ok) {
    throw new Error(
      described.err.type === 'NO_GRANT'
        ? `no ${provider} grant for account ${accountId} (disconnected?)`
        : `could not read ${provider} grant for ${accountId}: ${described.err.type}`
    );
  }

  const site = readAtlassianMetadata(described.val.metadata);
  if (!site.cloudId) {
    throw new Error(`${provider} grant for ${accountId} carries no cloud id`);
  }

  return {
    auth: grantFetch(grant),
    accountId,
    cloudId: site.cloudId,
    siteUrl: site.siteUrl,
  };
}

/**
 * Turning an Atlassian authorization code into a pinned, identified grant.
 *
 * Shared by the `auth` CLI, the gateway's OAuth callback, and the self-service
 * portal on purpose. The sequence — exchange, then enumerate accessible sites,
 * then settle on exactly one of them, then resolve the account against *that*
 * site — is a security control, not glue. Three copies of it would eventually
 * disagree, and the copy that dropped a step would be the one nobody noticed.
 *
 * The one thing the three callers do not agree on is which site the grant is
 * for, so that is the parameter. Two callers already know and are pinning
 * against config; the portal is discovering it, because a user picking from
 * Atlassian's consent screen is the only thing that can say.
 */

import type { AtlassianConfig } from '../config.js';
import { JiraClient } from '../jira/client.js';
import { asString } from '../util/coerce.js';
import {
  assertCloudIdInGrant,
  exchangeAuthorizationCode,
  fetchAccessibleResources,
  type AccessibleResource,
  type FetchLike,
} from './atlassian.js';
import type { Grant } from './token-store.js';

export interface CompletedAuthorization {
  grant: Grant;
  /** The pinned site. */
  site: AccessibleResource;
  /** Every site the grant covers, so a caller can warn when it spans several. */
  resources: AccessibleResource[];
}

export class AuthorizationIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationIncompleteError';
  }
}

/**
 * Decides which of the sites in a grant it is for.
 *
 * Throwing is the expected way to decline — the message reaches a human, so it
 * should say what they can do about it.
 */
export type SiteChooser = (
  resources: readonly AccessibleResource[],
) => AccessibleResource | Promise<AccessibleResource>;

/**
 * The pinned form: refuse unless the configured cloud ID is in the grant.
 *
 * What the CLI and the MCP callback both want. A user who picks the wrong entry
 * in Atlassian's site dropdown gets a perfectly valid grant for a site this
 * endpoint does not serve, and it is refused here — after the exchange, before
 * anything is written.
 */
export function completeAtlassianAuthorization(
  config: AtlassianConfig,
  code: string,
  options: { fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<CompletedAuthorization> {
  return discoverAtlassianAuthorization(config, code, {
    ...options,
    chooseSite: (resources) => assertCloudIdInGrant(resources, config.cloudId),
  });
}

export async function discoverAtlassianAuthorization(
  config: AtlassianConfig,
  code: string,
  options: { chooseSite: SiteChooser; fetchImpl?: FetchLike; now?: () => Date },
): Promise<CompletedAuthorization> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  const tokens = await exchangeAuthorizationCode(config, code, fetchImpl);

  // Atlassian's consent screen carries a site picker, so the grant covers the
  // site the user chose and `accessible-resources` reports only that one.
  const resources = await fetchAccessibleResources(tokens.accessToken, fetchImpl);
  const site = await options.chooseSite(resources);

  // Identify the human, against the site that was just settled on rather than
  // against config: on the portal's path the two are not the same, and calling
  // `/myself` on a site the grant does not cover would 401 for a reason that
  // looks nothing like the actual mistake.
  const client = new JiraClient({
    cloudId: site.id,
    getAccessToken: () => Promise.resolve(tokens.accessToken),
    fetchImpl,
  });
  const me = await client.get<Record<string, unknown>>('/rest/api/3/myself');
  const accountId = asString(me.accountId);

  if (accountId === '') {
    throw new AuthorizationIncompleteError(
      'Jira did not return an account ID for the authorized user',
    );
  }

  return {
    grant: {
      atlassianClientId: config.clientId,
      cloudId: site.id,
      siteUrl: site.url,
      accountId,
      displayName: asString(me.displayName, 'unknown'),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      updatedAt: now().toISOString(),
    },
    site,
    resources,
  };
}

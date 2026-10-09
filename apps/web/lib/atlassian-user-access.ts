/**
 * A signed-in user's Atlassian grant for a given app, as route handlers
 * that act as that user need it: a fetcher the delegate attaches the token
 * to, plus the site and account the grant stands for.
 *
 * The MCP layer resolves access from an MCPToolContext, which a route
 * handler has no reason to fabricate — it has a session subject, not a tool
 * call. This is the same sequence (grant by subject → site identity →
 * fetcher) reachable from an ordinary request. No token is read here:
 * the delegate worker holds it (docs/delegate-key-design.md), refreshes it
 * when due and retries a 401 behind the fetcher.
 *
 * Errors come back as a string the caller can show the user verbatim: on
 * the connectors page every failure here has a user action attached
 * (connect it, reconnect it, ask an admin), so a generic 500 would waste
 * the one thing the page is for.
 */

import { readAtlassianMetadata, ATLASSIAN, ATLASSIAN_CONFLUENCE } from '@renkei/provider-grants';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';

export interface AtlassianUserAccess {
  auth: AuthedFetch;
  cloudId: string;
  accountId: string;
}

/** Which of the three Atlassian apps a caller wants to act through. */
export type AtlassianUserProvider = typeof ATLASSIAN | typeof ATLASSIAN_CONFLUENCE;

const LABELS: Record<string, string> = {
  [ATLASSIAN]: 'Jira',
  [ATLASSIAN_CONFLUENCE]: 'Confluence',
};

export async function resolveAtlassianUserAccess(
  subject: string,
  provider: AtlassianUserProvider
): Promise<AtlassianUserAccess | string> {
  const label = LABELS[provider] ?? provider;
  const ref = { provider, subject };

  const described = await delegateGrants().describe(ref);
  if (!described.ok) {
    switch (described.err.type) {
      case 'NO_GRANT':
        return `${label} is not connected. Connect it above, then try again.`;
      case 'DELEGATE_UNCONFIGURED':
      case 'DELEGATE_UNREACHABLE':
        return 'The credential service is unavailable; try again shortly.';
      default:
        return `Could not read the ${label} grant.`;
    }
  }

  const site = readAtlassianMetadata(described.val.metadata);
  if (!site.cloudId) return `The ${label} grant is missing its site id; reconnect it above.`;

  return { auth: grantFetch(ref), cloudId: site.cloudId, accountId: described.val.accountId };
}

/**
 * A signed-in user's live Atlassian token for a given app, for route
 * handlers that act as that user.
 *
 * The MCP layer resolves access from an MCPToolContext, which a route
 * handler has no reason to fabricate — it has a session subject, not a tool
 * call. This is the same sequence (grant by subject → proactive refresh →
 * cloud id) reachable from an ordinary request.
 *
 * Errors come back as a string the caller can show the user verbatim: on
 * the connectors page every failure here has a user action attached
 * (connect it, reconnect it, ask an admin), so a generic 500 would waste
 * the one thing the page is for.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import {
  getGrant,
  refreshGrantTokens,
  readAtlassianMetadata,
  AtlassianAdapter,
  ATLASSIAN,
  ATLASSIAN_CONFLUENCE,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { getAtlassianApp, getAtlassianConfluenceApp } from '@/lib/atlassian-app';
import { logger } from '@/lib/logger';

/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface AtlassianUserAccess {
  accessToken: string;
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
  tenantId: string,
  subject: string,
  provider: AtlassianUserProvider,
  origin: string
): Promise<AtlassianUserAccess | string> {
  const label = LABELS[provider] ?? provider;
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Server misconfigured (encryption key).';
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', provider)
    .where('subject', '=', subject)
    .executeTakeFirst();
  if (!row) return `${label} is not connected. Connect it above, then try again.`;

  const grantResult = await getGrant(provider, tenantId, row.provider_account_id, keyResult.val);
  if (!grantResult.ok || !grantResult.val) return `Could not read the ${label} grant.`;
  let grant: ProviderGrant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app =
      provider === ATLASSIAN
        ? await getAtlassianApp(tenantId, origin)
        : await getAtlassianConfluenceApp(tenantId, origin);
    if (!app) return `${label} is no longer configured for this organization.`;
    const refreshed = await refreshGrantTokens(
      new AtlassianAdapter(app.clientSecret, provider),
      tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? `Your ${label} authorization was revoked. Reconnect it above.`
        : `Could not refresh the ${label} token; try again shortly.`;
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const site = readAtlassianMetadata(grant.metadata);
  if (!site.cloudId) return `The ${label} grant is missing its site id; reconnect it above.`;

  return { accessToken: grant.accessToken, cloudId: site.cloudId, accountId: grant.accountId };
}

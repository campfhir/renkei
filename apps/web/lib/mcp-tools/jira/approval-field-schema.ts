/**
 * Live, best-effort field-type info for an approval card's editable
 * fields — resolved fresh from the approver's own Jira grant when the
 * card renders, the same grant/refresh path `executeCreateIssue`
 * (lib/actionable-items.ts) already uses outside an MCP call. Never
 * throws: a card whose fetch fails, or whose Jira is not connected, still
 * renders — with its fields editable as plain text instead of the typed
 * picklist/checkbox/number controls a resolved schema enables.
 *
 * This is a live external call made from a page render, not a write
 * action — a deliberate choice (see the card feed's own review of it):
 * the alternative was showing customfield_10016 without knowing it is a
 * number, or "Anti-Kickback Review" without knowing its two valid values.
 * Both `loadFieldSchema` and `enrichFieldsWithAllowedValues` cache
 * (24h/5min) in-process, so only the first render of a given site/project
 * pays the round trip.
 */

import { getDatabase } from '@renkei/db';
import { getJiraGrant, ATLASSIAN } from '@/lib/tenant-operations';
import type { MCPToolContext } from '../common';
import { cacheTokenMetadata } from '../common';
import { oauthJiraAuth } from './jira-auth';
import {
  enrichFieldsWithAllowedValues,
  loadFieldSchema,
  type EnrichmentSource,
  type JiraField,
} from './field-schema';

export async function loadApprovalFieldSchema(
  tenantId: string,
  subject: string,
  source: EnrichmentSource
): Promise<JiraField[] | null> {
  try {
    const dbResult = getDatabase();
    if (!dbResult.ok) return null;

    const grantRow = await dbResult.val
      .selectFrom('provider_grants')
      .select('provider_account_id')
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', ATLASSIAN)
      .where('subject', '=', subject)
      .executeTakeFirst();
    if (!grantRow) return null;

    const grantResult = await getJiraGrant(tenantId, grantRow.provider_account_id);
    if (!grantResult.ok || !grantResult.val) return null;
    const grant = grantResult.val;

    // Lets jiraFetch (common.ts) refresh on a 401 without a caller needing
    // to orchestrate that itself — same as executeCreateIssue.
    cacheTokenMetadata(grant.accessToken, tenantId, grant.accountId, grant.subject ?? undefined);

    const context: MCPToolContext = {
      tenantId,
      accountId: grant.accountId,
      siteUrl: grant.siteUrl,
      apiBaseUrl: `https://api.atlassian.com/ex/jira/${grant.cloudId}`,
      accessToken: grant.accessToken,
      maxJqlResults: 50,
      subject,
    };
    const auth = oauthJiraAuth(context);
    const schema = await loadFieldSchema(context, auth);
    return await enrichFieldsWithAllowedValues(context, auth, schema, source);
  } catch {
    return null;
  }
}

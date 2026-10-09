/**
 * Live, best-effort field-type info for an approval card's editable
 * fields — resolved fresh from the approver's own Jira grant when the
 * card renders, the same grant path `executeCreateIssue`
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

import { ATLASSIAN, readAtlassianMetadata } from '@renkei/provider-grants';
import { delegateGrants, grantFetch } from '@renkei/delegate-client';
import type { MCPToolContext } from '../common';
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
    // The approver's own grant, by subject — described by the delegate for
    // its site, fetched through the delegate for its token.
    const ref = { provider: ATLASSIAN, subject };
    const described = await delegateGrants().describe(ref);
    if (!described.ok) return null;
    const grant = described.val;
    const site = readAtlassianMetadata(grant.metadata);
    if (!site.cloudId) return null;

    const context: MCPToolContext = {
      accountId: grant.accountId,
      siteUrl: site.siteUrl,
      apiBaseUrl: `https://api.atlassian.com/ex/jira/${site.cloudId}`,
      jiraAuth: grantFetch(ref),
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

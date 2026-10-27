/**
 * The Automation REST API, on the person's own Atlassian API token.
 *
 * Every rule-management and manual-rule operation of Atlassian's Automation
 * API says "Forge and OAuth2 apps cannot access this REST resource": it
 * takes an API token (HTTP Basic, email:token) or a browser session, and
 * nothing else. So the Jira Administration card takes an API token beside
 * the OAuth grant, the delegate keeps it as a grant of its own
 * (ATLASSIAN_ADMIN_TOKEN) and attaches it as Basic on the way to
 * api.atlassian.com, and the automation tools and the apply route reach
 * the API through the same client the rest of Jira administration uses —
 * with this base in place of the Jira gateway, and a 401 read as "the
 * token", not "a scope".
 *
 * Base: https://api.atlassian.com/automation/public/jira/{cloudId}; a
 * deployment may point it at a stand-in (JIRA_AUTOMATION_API_BASE_URL), as
 * the browser suite does, and the delegate honors the same variable.
 */

import { ATLASSIAN_ADMIN_TOKEN, readAtlassianTokenMetadata } from '@renkei/provider-grants';
import { delegateGrants, grantFetch } from '@renkei/delegate-client';
import { grantRefusalText } from '@/lib/grant-refusals';
import type { MCPToolContext } from '../common';
import { grantRow } from '../grant-row';
import type { JiraAdminAccess } from './client';

const JIRA_AUTOMATION_API_BASE =
  process.env.JIRA_AUTOMATION_API_BASE_URL?.replace(/\/+$/, '') ||
  'https://api.atlassian.com/automation/public';

export const AUTOMATION_TOKEN_LABEL = 'Atlassian API token';

export const NO_TOKEN =
  'No Atlassian API token is saved. Automation rules are read and changed with one — Jira’s ' +
  'Automation API refuses OAuth apps — so save yours on the Connectors page, under Jira ' +
  'Administration.';

export interface AutomationAccess extends JiraAdminAccess {
  /** Whose token: the Basic user name the delegate sends. */
  email: string;
}

/** The Automation API's base for a site. */
export function automationBaseFor(cloudId: string): string {
  return `${JIRA_AUTOMATION_API_BASE}/jira/${encodeURIComponent(cloudId)}`;
}

/**
 * The person's API token grant as a fetcher on the Automation API, plus
 * the site it was saved for. By subject only, so the apply route — a
 * browser session — resolves it the way a tool does.
 */
export async function resolveAutomationAccess(
  context: Pick<MCPToolContext, 'subject'>
): Promise<AutomationAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const ref = { provider: ATLASSIAN_ADMIN_TOKEN, subject: context.subject };
  const described = await delegateGrants().describe(ref);
  if (!described.ok) {
    if (described.err.type === 'NO_GRANT') return NO_TOKEN;
    return described.err.type === 'GRANT_UNREADABLE' || described.err.type === 'DELEGATE_ERROR'
      ? 'Could not read the Atlassian API token.'
      : grantRefusalText(described.err.type, AUTOMATION_TOKEN_LABEL);
  }
  const meta = readAtlassianTokenMetadata(described.val.metadata);
  if (!meta.cloudId || !meta.email) {
    return 'The saved Atlassian API token is missing its site or email; save it again on the Connectors page.';
  }
  return {
    cloudId: meta.cloudId,
    siteUrl: meta.siteUrl,
    accountId: described.val.accountId,
    email: meta.email,
    auth: grantFetch(ref),
    label: AUTOMATION_TOKEN_LABEL,
    baseUrl: automationBaseFor(meta.cloudId),
    apiToken: true,
  };
}

/** Whether a token is saved — the grant row alone, for the apply gate and the review page. */
export async function hasAutomationToken(subject: string): Promise<boolean> {
  return (await grantRow(ATLASSIAN_ADMIN_TOKEN, subject)) !== undefined;
}

// ---- ARIs ------------------------------------------------------------------

/** `ari:cloud:jira:{cloudId}:project/{id}` — how a rule names the spaces it is scoped to. */
export function projectAri(cloudId: string, projectId: string): string {
  return `ari:cloud:jira:${cloudId}:project/${projectId}`;
}

/** `ari:cloud:jira:{cloudId}:issue/{id}` — what a manual rule is run on. */
export function issueAri(cloudId: string, issueId: string): string {
  return `ari:cloud:jira:${cloudId}:issue/${issueId}`;
}

/** The project id an ARI names, or null for any other ARI (a site-wide scope, say). */
export function projectIdOfAri(ari: string): string | null {
  const match = /^ari:cloud:jira:[^:]+:project\/(\d+)$/.exec(ari);
  return match?.[1] ?? null;
}

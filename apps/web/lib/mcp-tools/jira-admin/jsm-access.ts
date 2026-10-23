/**
 * The person's Jira Service Management grant, as the request type change
 * uses it (lib/jira-admin/request-type.ts): creating a request type is
 * documented under a granular JSM scope only, which the classic Jira
 * Administration app cannot carry, so that one write goes out on the JSM
 * grant — the same gateway, a different token.
 *
 * Three readers, one rule. The propose tool takes the grant off the MCP
 * context (the route resolved it once for the jsm_ tools); the apply route
 * resolves it by subject, the way resolveJiraAdminAccess does; and the
 * apply gate reads only the grant row's scopes, so a review page can say
 * "reconnect JSM with the box ticked" without touching a token. The tool
 * is offered, and a request applied, only when the JSM grant holds every
 * scope in REQUEST_TYPE_JSM_SCOPES — a legacy grant with no scope list
 * passes, as withScopeGate lets one pass.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ATLASSIAN_JSM, readAtlassianMetadata } from '@renkei/provider-grants';
import { delegateGrants, grantFetch } from '@renkei/delegate-client';
import { grantRefusalText } from '@/lib/grant-refusals';
import { REQUEST_TYPE_JSM_SCOPES } from '@/lib/jira-admin/request-type';
import type { MCPToolContext } from '../common';
import type { JiraAdminAccess } from './client';

export const JSM_LABEL = 'Jira Service Management';

export const NOT_CONNECTED =
  'Jira Service Management is not connected. Request types are created on that ' +
  'connection; connect it on the Connectors page with “Set up request types” ticked.';

/** Does a JSM grant's scope list carry what request types need? Unknown passes. */
export function holdsRequestTypeScopes(scopes: readonly string[] | undefined): boolean {
  if (scopes === undefined) return true;
  const granted = new Set(scopes);
  return REQUEST_TYPE_JSM_SCOPES.every((scope) => granted.has(scope));
}

/** The scopes a JSM grant lacks for request types; empty when it holds them all. */
export function missingRequestTypeScopes(scopes: readonly string[] | undefined): string[] {
  if (scopes === undefined) return [];
  const granted = new Set(scopes);
  return REQUEST_TYPE_JSM_SCOPES.filter((scope) => !granted.has(scope));
}

/** The JSM grant the MCP route put on the context, as a fetcher on the Jira gateway. */
export function jsmAccessFromContext(context: MCPToolContext): JiraAdminAccess | string {
  const grant = context.jsmGrant;
  if (!grant || !grant.auth) return NOT_CONNECTED;
  if (!holdsRequestTypeScopes(grant.scopes)) {
    return (
      'Your Jira Service Management connection does not include ' +
      `${missingRequestTypeScopes(grant.scopes).join(', ')}. Reconnect it with “Set up request ` +
      'types” ticked.'
    );
  }
  return {
    cloudId: grant.cloudId,
    siteUrl: '',
    accountId: grant.accountId,
    auth: grant.auth,
    label: JSM_LABEL,
  };
}

/** The JSM grant by subject — for the apply route, a browser session rather than an MCP call. */
export async function resolveJsmAccess(subject: string): Promise<JiraAdminAccess | string> {
  const ref = { provider: ATLASSIAN_JSM, subject };
  const described = await delegateGrants().describe(ref);
  if (!described.ok) {
    if (described.err.type === 'NO_GRANT') return NOT_CONNECTED;
    return described.err.type === 'GRANT_UNREADABLE' || described.err.type === 'DELEGATE_ERROR'
      ? 'Could not read the Jira Service Management grant.'
      : grantRefusalText(described.err.type, JSM_LABEL);
  }
  const site = readAtlassianMetadata(described.val.metadata);
  if (!site.cloudId) {
    return 'The Jira Service Management grant is missing its site id; reconnect on the Connectors page.';
  }
  return {
    cloudId: site.cloudId,
    siteUrl: site.siteUrl,
    accountId: described.val.accountId,
    auth: grantFetch(ref),
    label: JSM_LABEL,
  };
}

/**
 * The JSM grant row's scopes, or null without a grant — read straight from
 * the row, the tool catalog's way, so a page can ask without a token.
 */
export async function jsmGrantScopes(db: Kysely<DB>, subject: string): Promise<string[] | null> {
  const row = await db
    .selectFrom('provider_grants')
    .select(['requested_scopes', 'granted_scopes'])
    .where('provider', '=', ATLASSIAN_JSM)
    .where('subject', '=', subject)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return row.granted_scopes ?? row.requested_scopes;
}

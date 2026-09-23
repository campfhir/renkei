/**
 * How the jira_admin_ tools reach Jira — injected, not resolved inline, the
 * ConfluenceAuth shape (../confluence/confluence-auth.ts): jiraAdminGet
 * (client.ts) takes an `access` separate from resolving one, so resolving
 * is the only thing that needs to be swappable. Scope enforcement stays at
 * registration, via jiraAdminScopeFor + withScopeGate in index.ts.
 */

import { resolveJiraAdminAccess, type JiraAdminAccess } from './client';
import type { MCPToolContext } from '../common';

export interface JiraAdminAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'pat';
  /** The credential for one call, or a human-readable reason there is none. */
  resolve(): Promise<JiraAdminAccess | string>;
}

/** Production's only implementation: the caller's own Jira Administration grant. */
export function oauthJiraAdminAuth(context: MCPToolContext): JiraAdminAuth {
  return {
    kind: 'oauth',
    resolve: () => resolveJiraAdminAccess(context),
  };
}

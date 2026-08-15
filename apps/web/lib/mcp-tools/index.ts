/**
 * MCP Tools Registry
 *
 * Central registry for all available MCP tools.
 * Tools are organized by product/service for modularity.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from './common';
import { registerJiraTools } from './jira';
import { granularJiraScopes, oauthJiraAuth } from './jira/jira-auth';
import { registerJiraServiceManagementTools } from './jira-service-management';
import { withScopeGate } from './capability-gate';

export type { MCPToolContext };
export { ok, okWithLink, toolError, cacheTokenMetadata, cacheUserDisplayName } from './common';

/**
 * Register all MCP tools with the server.
 */
export async function registerAllTools(server: McpServer, context: MCPToolContext): Promise<void> {
  await registerJiraTools(
    withScopeGate(server, context.grantedScopes, granularJiraScopes),
    context,
    oauthJiraAuth(context)
  );
  // JSM/Ops tools run on the second Atlassian app's grant when the caller
  // has connected it — its own token, cloud id, and scope gates. Without
  // one, they fall back to the main grant (the pre-split single-app shape).
  const jsmContext: MCPToolContext = context.jsmGrant
    ? {
        ...context,
        accessToken: context.jsmGrant.accessToken,
        accountId: context.jsmGrant.accountId,
        cloudId: context.jsmGrant.cloudId,
        apiBaseUrl: `https://api.atlassian.com/ex/jira/${context.jsmGrant.cloudId}`,
        grantedScopes: context.jsmGrant.scopes,
      }
    : context;
  await registerJiraServiceManagementTools(server, jsmContext);
}

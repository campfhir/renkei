/**
 * MCP Tools Registry
 *
 * Central registry for all available MCP tools.
 * Tools are organized by product/service for modularity.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from './common';
import { registerJiraTools } from './jira';
import { registerJiraServiceManagementTools } from './jira-service-management';
import { withScopeGate } from './capability-gate';

/** The classic-Jira tools that read directory data rather than work items. */
const USER_DIRECTORY_TOOLS = new Set([
  'list_users',
  'get_user',
  'list_groups',
  'list_group_members',
  'get_user_groups',
]);

/**
 * Classic Jira scope resolution: reads need read:jira-work, mutations add
 * write:jira-work, and the user-directory tools need read:jira-user instead.
 *
 * Board/sprint tools are deliberately NOT gated on the granular
 * read:board-scope:jira-software — classic read:jira-work covers the agile
 * API for some app configurations and not others (mixing granular scopes
 * into the app changes how Atlassian evaluates the token), so the granular
 * scope rides in the catalog for the token's sake while registration keys
 * on the classic scope that always accompanies it.
 */
function classicJiraScopes(toolName: string, readOnly: boolean): string[] {
  if (USER_DIRECTORY_TOOLS.has(toolName)) return ['read:jira-user'];
  return readOnly ? ['read:jira-work'] : ['read:jira-work', 'write:jira-work'];
}

export type { MCPToolContext };
export { ok, okWithLink, toolError, cacheTokenMetadata, cacheUserDisplayName } from './common';

/**
 * Register all MCP tools with the server.
 */
export async function registerAllTools(server: McpServer, context: MCPToolContext): Promise<void> {
  await registerJiraTools(withScopeGate(server, context.grantedScopes, classicJiraScopes), context);
  await registerJiraServiceManagementTools(server, context);
}

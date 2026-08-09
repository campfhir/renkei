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

/** The Jira tools that read directory data rather than work items. */
const USER_DIRECTORY_TOOLS = new Set([
  'list_users',
  'get_user',
  'list_groups',
  'list_group_members',
  'get_user_groups',
]);

/** Board/sprint reads and writes go through the Jira Software API. */
const BOARD_READ_TOOLS = new Set(['list_boards', 'list_sprints']);
const BOARD_WRITE_TOOLS = new Set([
  'create_sprint',
  'complete_sprint',
  'move_issue_to_sprint',
  'remove_issue_from_sprint',
]);

/** Delete tools gate on their own delete:* scope — a separate bundle. */
const DELETE_TOOL_SCOPES: Record<string, string> = {
  delete_issue: 'delete:issue:jira',
  delete_comment: 'delete:comment:jira',
  delete_filter: 'delete:filter:jira',
  delete_worklog: 'delete:issue-worklog:jira',
  delete_component: 'delete:project.component:jira',
  delete_issue_link: 'delete:issue-link:jira',
};

/**
 * Granular Jira scope resolution, keyed on one MARKER scope per capability
 * bundle (lib/atlassian-scopes.ts): bundles travel whole, so a bundle's
 * presence is provable from any one of its scopes. read:issue:jira marks the
 * read bundle, write:issue:jira the write bundle, the board scopes their
 * Jira Software bundles, and each delete tool its own delete scope.
 * Directory tools key on read:user:jira, which rides the read bundle — with
 * granular scopes there is no separate directory grant to distinguish.
 */
function granularJiraScopes(toolName: string, readOnly: boolean): string[] {
  if (BOARD_READ_TOOLS.has(toolName)) return ['read:board-scope:jira-software'];
  if (BOARD_WRITE_TOOLS.has(toolName)) return ['write:board-scope:jira-software'];
  if (USER_DIRECTORY_TOOLS.has(toolName)) return ['read:user:jira'];
  const deleteScope = DELETE_TOOL_SCOPES[toolName];
  if (deleteScope) return ['read:issue:jira', deleteScope];
  return readOnly ? ['read:issue:jira'] : ['read:issue:jira', 'write:issue:jira'];
}

export type { MCPToolContext };
export { ok, okWithLink, toolError, cacheTokenMetadata, cacheUserDisplayName } from './common';

/**
 * Register all MCP tools with the server.
 */
export async function registerAllTools(server: McpServer, context: MCPToolContext): Promise<void> {
  await registerJiraTools(
    withScopeGate(server, context.grantedScopes, granularJiraScopes),
    context
  );
  await registerJiraServiceManagementTools(server, context);
}

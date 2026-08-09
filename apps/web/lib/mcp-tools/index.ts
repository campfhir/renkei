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
  'jira_list_users',
  'jira_get_user',
  'jira_list_groups',
  'jira_list_group_members',
  'jira_get_user_groups',
]);

/** Board/sprint reads and writes go through the Jira Software API. */
const BOARD_READ_TOOLS = new Set(['jira_list_boards', 'jira_list_sprints']);
const BOARD_WRITE_TOOLS = new Set([
  'jira_create_sprint',
  'jira_complete_sprint',
  'jira_move_issue_to_sprint',
  'jira_remove_issue_from_sprint',
]);

/** Delete tools gate on their own delete:* scope — a separate bundle. */
const DELETE_TOOL_SCOPES: Record<string, string> = {
  jira_delete_issue: 'delete:issue:jira',
  jira_delete_comment: 'delete:comment:jira',
  jira_delete_filter: 'delete:filter:jira',
  jira_delete_worklog: 'delete:issue-worklog:jira',
  jira_delete_component: 'delete:project.component:jira',
  jira_delete_issue_link: 'delete:issue-link:jira',
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

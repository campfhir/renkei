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

export type { MCPToolContext };
export { ok, okWithLink, toolError } from './common';

/**
 * Register all MCP tools with the server.
 */
export async function registerAllTools(server: McpServer, context: MCPToolContext): Promise<void> {
  await registerJiraTools(server, context);
  await registerJiraServiceManagementTools(server, context);
}

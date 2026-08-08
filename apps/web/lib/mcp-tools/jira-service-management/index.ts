/**
 * Jira Service Management (JSM) MCP tools
 *
 * Tools for managing customer requests, service desks, and support operations.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerJsmTools } from './jsm';
import { registerRequestDetailsTools } from './request-details';
import { registerJsmCustomerTools } from './customers';
import { registerJsmOpsTools } from './ops';

export async function registerJiraServiceManagementTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  await registerJsmTools(server, context);
  await registerRequestDetailsTools(server, context);
  await registerJsmCustomerTools(server, context);
  await registerJsmOpsTools(server, context);
}

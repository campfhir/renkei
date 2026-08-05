/**
 * Jira work items MCP tools
 *
 * Tools for managing Jira issues, boards, sprints, and project structure.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MCPToolContext } from '../common';
import { registerReadTools } from './read';
import { registerWriteTools } from './write';
import { registerBulkTools } from './bulk';
import { registerSprintTools } from './sprints';
import { registerProjectTools } from './project';
import { registerAttachmentTools } from './attachments';
import { registerUtilityTools } from './utilities';

export async function registerJiraTools(server: McpServer, context: MCPToolContext): Promise<void> {
  await registerReadTools(server, context);
  await registerWriteTools(server, context);
  await registerBulkTools(server, context);
  await registerSprintTools(server, context);
  await registerProjectTools(server, context);
  await registerAttachmentTools(server, context);
  await registerUtilityTools(server, context);
}

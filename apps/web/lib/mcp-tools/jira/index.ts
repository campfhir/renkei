/**
 * Jira work items MCP tools
 *
 * Tools for managing Jira issues, boards, sprints, and project structure.
 * Organized into Read-Only and Mutating operations.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { registerReadTools } from './read';
import { registerWriteTools } from './write';
import { registerBulkTools } from './bulk';
import { registerSprintTools } from './sprints';
import { registerProjectTools } from './project';
import { registerAttachmentTools } from './attachments';
import { registerUtilityTools } from './utilities';
import { registerUserTools } from './users';
import { registerWorklogTools } from './worklogs';
import { registerIssueLinkTools } from './issue-links';
import { registerVersionTools } from './versions';
import { registerComponentTools } from './components';
import { registerFilterTools } from './filters';
import { registerCommentTools } from './comments';
import { registerWatchTools } from './watches';

export async function registerJiraTools(server: McpServer, context: MCPToolContext): Promise<void> {
  // Read-Only Tools
  await registerReadTools(server, context);
  await registerProjectTools(server, context);
  await registerSprintTools(server, context);
  await registerUserTools(server, context);
  await registerIssueLinkTools(server, context);
  await registerVersionTools(server, context);
  await registerComponentTools(server, context);
  await registerFilterTools(server, context);
  await registerCommentTools(server, context);
  await registerWatchTools(server, context);

  // Mutating Operations
  await registerWriteTools(server, context);
  await registerBulkTools(server, context);
  await registerAttachmentTools(server, context);
  await registerUtilityTools(server, context);
  await registerWorklogTools(server, context);
}

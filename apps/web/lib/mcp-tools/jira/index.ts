/**
 * Jira work items MCP tools
 *
 * Tools for managing Jira issues, boards, sprints, and project structure.
 * Organized into Read-Only and Mutating operations.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import type { JiraAuth } from './jira-auth';
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

export async function registerJiraTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // Read-Only Tools
  await registerReadTools(server, context, auth);
  await registerProjectTools(server, context, auth);
  await registerSprintTools(server, context, auth);
  await registerUserTools(server, context, auth);
  await registerIssueLinkTools(server, context, auth);
  await registerVersionTools(server, context, auth);
  await registerComponentTools(server, context, auth);
  await registerFilterTools(server, context, auth);
  await registerCommentTools(server, context, auth);
  await registerWatchTools(server, context, auth);

  // Mutating Operations
  await registerWriteTools(server, context, auth);
  await registerBulkTools(server, context, auth);
  await registerAttachmentTools(server, context, auth);
  // No auth param: analyze_transcript makes no Jira API calls at all.
  await registerUtilityTools(server, context);
  await registerWorklogTools(server, context, auth);
}

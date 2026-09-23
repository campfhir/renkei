/**
 * Jira Administration MCP tools (jira_admin_*), over the caller's own grant
 * on the fifth Atlassian app ("Renkei Jira Admin"). Its own connector and
 * capability key — the onbase-admin arrangement — so an org admin can switch
 * it off or limit its audience without touching anyone's everyday Jira, and
 * a tool whose classic scope the grant lacks is never registered
 * (jiraAdminScopeFor in ./scopes.ts).
 *
 * Admin WRITES arrive as change requests: a jira_admin_propose_ tool stores
 * the exact operations and changes nothing in Jira, and the person applies
 * the request from a signed-in Renkei session — never from an MCP tool
 * call (./changes.ts, lib/jira-admin, docs/project-management-design.md).
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';
import { jiraAdminScopeFor } from './scopes';
import type { JiraAdminAuth } from './jira-admin-auth';
import { registerAccessTools } from './access';
import { registerFieldTools } from './fields';
import { registerSpaceTools } from './spaces';
import { registerPlanTools } from './plans';
import { registerChangeTools } from './changes';

export const JIRA_ADMIN_MCP_CONNECTOR = 'jira-admin';

export async function registerJiraAdminTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.jiraAdminScopes, (name) =>
    jiraAdminScopeFor(name)
  );

  await registerAccessTools(server, context, auth);
  await registerFieldTools(server, context, auth);
  await registerSpaceTools(server, context, auth);
  await registerPlanTools(server, context, auth);
  await registerChangeTools(server, context, auth);
}

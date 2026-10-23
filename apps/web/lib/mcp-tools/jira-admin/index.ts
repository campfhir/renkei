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
 *
 * Automation rules stand on a credential of their own: Atlassian's
 * Automation API refuses OAuth apps, so the person saves an API token
 * beside this grant (./automation-client.ts), and the automation tools
 * register only once one is there.
 *
 * One tool stands on two grants: jira_admin_propose_request_type, whose
 * write Atlassian documents under a granular JSM scope only, reads the
 * space here and the service desk on the person's JSM grant, and registers
 * only when both are connected with what they need (./jsm-access.ts).
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
import { registerTemplateTools } from './templates';
import { registerProposeSpaceTools } from './propose-space';
import { registerProposeFieldTools } from './propose-field';
import { registerProposeWorkTypeTools } from './propose-work-type';
import { registerScreenTools } from './screens';
import { registerProposeRequestTypeTools } from './propose-request-type';
import { holdsRequestTypeScopes } from './jsm-access';
import { registerAutomationTools } from './automation-tools';

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
  await registerTemplateTools(server, context, auth);
  await registerProposeSpaceTools(server, context, auth);
  await registerProposeFieldTools(server, context, auth);
  await registerProposeWorkTypeTools(server, context, auth);
  await registerScreenTools(server, context, auth);
  // Request types are a Jira Administration tool that writes on the Jira
  // Service Management grant (jsm-access.ts): offered only when that grant
  // is connected with the scopes the write takes, on top of this one's.
  if (context.jsmGrant && holdsRequestTypeScopes(context.jsmGrant.scopes)) {
    await registerProposeRequestTypeTools(server, context, auth);
  }
  // Automation rules take the person's own Atlassian API token (the API
  // refuses OAuth apps): offered once one is saved beside this grant.
  if (context.jiraAdminTokenAvailable === true) {
    await registerAutomationTools(server, context, auth);
  }
}

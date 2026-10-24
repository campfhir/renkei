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
import { registerRequestTools } from './request-change';
import { ROLE_OPERATOR } from '@/lib/access';

export const JIRA_ADMIN_MCP_CONNECTOR = 'jira-admin';

export async function registerJiraAdminTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: JiraAdminAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.jiraAdminScopes, (name) =>
    jiraAdminScopeFor(name)
  );

  // Approving is an operator's, so building a proposal is too: someone who
  // is known not to hold the role keeps every read (the field, space and
  // plan lookups they need to describe what they want) and gets a request
  // in words (request-change.ts) in place of the propose tools. Roles are
  // empty for an agent's token and for tokens older than their recording;
  // those keep every tool, since the approval, not the tool list, is the
  // control.
  const roles = context.roles ?? [];
  const knownNonOperator = roles.length > 0 && !roles.includes(ROLE_OPERATOR);
  const visible = knownNonOperator
    ? withoutTools(server, (name) => name.startsWith('jira_admin_propose_'))
    : server;

  await registerAccessTools(visible, context, auth);
  await registerFieldTools(visible, context, auth);
  await registerSpaceTools(visible, context, auth);
  await registerPlanTools(visible, context, auth);
  await registerChangeTools(visible, context, auth);
  await registerTemplateTools(visible, context, auth);
  await registerProposeSpaceTools(visible, context, auth);
  await registerProposeFieldTools(visible, context, auth);
  await registerProposeWorkTypeTools(visible, context, auth);
  await registerScreenTools(visible, context, auth);
  // Request types are a Jira Administration tool that writes on the Jira
  // Service Management grant (jsm-access.ts): offered only when that grant
  // is connected with the scopes the write takes, on top of this one's.
  if (context.jsmGrant && holdsRequestTypeScopes(context.jsmGrant.scopes)) {
    await registerProposeRequestTypeTools(visible, context, auth);
  }
  // Automation rules take the person's own Atlassian API token (the API
  // refuses OAuth apps): offered once one is saved beside this grant.
  if (context.jiraAdminTokenAvailable === true) {
    await registerAutomationTools(visible, context, auth);
  }
  // A request in words is the everyday Jira connector's to offer
  // (jira_request_admin_change); this one is for a person who holds only
  // the admin connection, so nobody sees two tools for one thing.
  if (!context.jiraAuth) registerRequestTools(visible, context, auth);
}

/** The server, less the tools `skip` names: they are never registered. */
function withoutTools(server: McpServer, skip: (name: string) => boolean): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: Parameters<McpServer['registerTool']>) =>
          skip(args[0]) ? undefined : target.registerTool(...args);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

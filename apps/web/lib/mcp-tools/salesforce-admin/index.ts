/**
 * Salesforce admin MCP tools (salesforce_admin_*), over the caller's own
 * grant on the organization's admin connector for the org a call acts in
 * (docs/salesforce-connectors-design.md, "The admin connector").
 *
 * Reads describe how the org is built. Proposals store a change request,
 * have Salesforce validate it with a check-only deploy, and return its
 * review link; nothing here applies one — only the person can, from that
 * page in their browser. Every tool takes `org` (salesforce_admin_list_orgs
 * names them), and with several orgs connected it must be given: the admin
 * connector never picks an org to change by default.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { takesChanges } from '@renkei/connector-salesforce';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';
import type { SalesforceAuth } from '../salesforce/salesforce-auth';
import { registerOrgTools } from '../salesforce/orgs';
import { adminOrgField, withOrgSelection } from '../salesforce/org-choice';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import { salesforceAdminScopeFor } from './scopes';
import { registerAdminReadTools } from './reads';
import { registerAdminProposalTools } from './propose';
import { registerAdminLayoutTools } from './layout-tools';
import { registerAdminChangeTools } from './propose-changes';
import { registerAdminObjectTools } from './propose-object';
import { registerAdminPermissionTools } from './permissions';
import { registerAdminPicklistTools } from './picklist-tools';
import { registerAdminRecordTypeTools } from './record-type-tools';
import { registerAdminRequestTools } from './request-change';
import { ROLE_OPERATOR } from '@/lib/access';

export const SALESFORCE_ADMIN_MCP_CONNECTOR = SALESFORCE_ADMIN_KIND.key;

export function registerSalesforceAdminTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  // Fail closed: no recorded capabilities means no tools, never every tool.
  const server = withOrgSelection(
    withScopeGate(rawServer, context.salesforceAdminScopes ?? [], (name) =>
      salesforceAdminScopeFor(name)
    ),
    'salesforce_admin_list_orgs',
    adminOrgField
  );

  registerOrgTools(server, context, SALESFORCE_ADMIN_KIND, {
    name: 'salesforce_admin_list_orgs',
    prefix: 'salesforce_admin_',
    describe: (org) => (takesChanges(org) ? 'takes change requests' : 'read only'),
  });
  // Approving is an operator's, so building a proposal is too: someone who
  // is known not to hold the role keeps every read (the object, field,
  // picklist, layout and permission-set lookups they need to describe what
  // they want) and gets a request in words (request-change.ts) in place of
  // the propose tools. Roles are empty for an agent's token and for tokens
  // older than their recording; those keep every tool, since the approval,
  // not the tool list, is the control.
  const roles = context.roles ?? [];
  const knownNonOperator = roles.length > 0 && !roles.includes(ROLE_OPERATOR);
  const visible = knownNonOperator
    ? withoutTools(server, (name) => name.startsWith('salesforce_admin_propose_'))
    : server;

  registerAdminReadTools(visible, context, auth);
  registerAdminProposalTools(visible, context, auth);
  registerAdminObjectTools(visible, context, auth);
  registerAdminChangeTools(visible, context, auth);
  registerAdminPicklistTools(visible, context, auth);
  registerAdminRecordTypeTools(visible, context, auth);
  registerAdminLayoutTools(visible, context, auth);
  registerAdminPermissionTools(visible, context, auth);
  registerAdminRequestTools(visible, context, auth);
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

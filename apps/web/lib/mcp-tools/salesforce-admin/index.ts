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
  registerAdminReadTools(server, context, auth);
  registerAdminProposalTools(server, context, auth);
  registerAdminObjectTools(server, context, auth);
  registerAdminChangeTools(server, context, auth);
  registerAdminLayoutTools(server, context, auth);
  registerAdminPermissionTools(server, context, auth);
}

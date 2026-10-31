/**
 * Salesforce CRM MCP tools (salesforce_*), over the caller's own grant on
 * the organization's Salesforce app, in the organization's own org.
 *
 * Instance-agnostic: nothing here knows any particular org. The tools know
 * the platform — objects and fields, ids and key prefixes, lookups,
 * master-detail and junction objects, record types and dependent
 * picklists, owners, activities, history, reports — and read everything
 * specific to an org from that org at call time (the describe), so the same
 * tools work on standard and custom objects in any org. An organization's
 * own procedures belong in prompt libraries and agents built on these.
 *
 * Built on the core REST resources — sObjects, query, search, sObject
 * Collections and Tree — plus the Reports and Dashboards REST API, all at
 * the pinned v68.0 (docs/salesforce-connectors-design.md, "Built on the
 * core REST resources"). Salesforce's own permissions decide every call;
 * Renkei's capabilities (lib/salesforce-scopes.ts) decide which tools
 * register.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';
import { salesforceScopeFor } from './scopes';
import type { SalesforceAuth } from './salesforce-auth';
import { registerRecordReadTools } from './records';
import { registerWriteTools } from './writes';
import { registerBulkTools } from './bulk';
import { registerReportTools } from './reports';
import { registerFileTools } from './files';
import { registerRequestAdminChangeTool } from './request-admin-change';
import { registerOrgTools } from './orgs';
import { orgField, withOrgSelection } from './org-choice';
import { registerSalesforcePreviewLookups } from './preview-lookups';

export const SALESFORCE_MCP_CONNECTOR = 'salesforce';

export function registerSalesforceTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  // Fail closed: no recorded capabilities means no tools, never every tool
  // (withScopeGate passes everything through for `undefined`).
  const server = withOrgSelection(
    withScopeGate(rawServer, context.salesforceScopes ?? [], (name) => salesforceScopeFor(name)),
    'salesforce_list_orgs',
    orgField
  );

  registerSalesforcePreviewLookups(context, auth);
  registerOrgTools(server, context);
  registerRecordReadTools(server, context, auth);
  registerWriteTools(server, context, auth);
  registerBulkTools(server, context, auth);
  registerReportTools(server, context, auth);
  registerFileTools(server, context, auth);
  registerRequestAdminChangeTool(server, context, auth);
}

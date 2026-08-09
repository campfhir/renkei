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
import { withScopeGate } from '../capability-gate';

// Granular marker scopes, one per capability bundle in
// lib/atlassian-scopes.ts — bundles travel whole, so a bundle's presence is
// provable from any one of its scopes.
const SD_READ = 'read:request:jira-service-management';
const SD_WRITE = 'write:request:jira-service-management';
const CUSTOMER_READ = 'read:customer:jira-service-management';
const CUSTOMER_WRITE = 'write:customer:jira-service-management';
const OPS_ALERT_READ = 'read:ops-alert:jira-service-management';
const OPS_ALERT_WRITE = 'write:ops-alert:jira-service-management';
const OPS_CONFIG_READ = 'read:ops-config:jira-service-management';
const OPS_CONFIG_WRITE = 'write:ops-config:jira-service-management';
const OPS_CONFIG_DELETE = 'delete:ops-config:jira-service-management';

function serviceDeskScopes(_toolName: string, readOnly: boolean): string[] {
  return readOnly ? [SD_READ] : [SD_READ, SD_WRITE];
}

function customerScopes(_toolName: string, readOnly: boolean): string[] {
  return readOnly ? [CUSTOMER_READ] : [CUSTOMER_READ, CUSTOMER_WRITE];
}

/**
 * The ops module spans three scope families: alerts, config, and config
 * deletion. Resolved by tool name, which the module's naming keeps honest.
 */
function opsScopes(toolName: string, readOnly: boolean): string[] {
  if (toolName.includes('alert')) {
    return readOnly ? [OPS_ALERT_READ] : [OPS_ALERT_READ, OPS_ALERT_WRITE];
  }
  if (toolName === 'jsm_ops_delete_override') return [OPS_CONFIG_READ, OPS_CONFIG_DELETE];
  return readOnly ? [OPS_CONFIG_READ] : [OPS_CONFIG_READ, OPS_CONFIG_WRITE];
}

export async function registerJiraServiceManagementTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  const scopes = context.grantedScopes;
  await registerJsmTools(withScopeGate(server, scopes, serviceDeskScopes), context);
  await registerRequestDetailsTools(withScopeGate(server, scopes, serviceDeskScopes), context);
  await registerJsmCustomerTools(withScopeGate(server, scopes, customerScopes), context);
  await registerJsmOpsTools(withScopeGate(server, scopes, opsScopes), context);
}

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
import { opsScopes, oauthJsmOpsAuth } from './ops-auth';
import { withScopeGate } from '../capability-gate';

// Granular marker scopes, one per capability bundle in
// lib/atlassian-scopes.ts — bundles travel whole, so a bundle's presence is
// provable from any one of its scopes. The Ops family's own scopes and
// opsScopes() live in ./ops-auth instead of here — that module's
// oauthJsmOpsAuth enforces them again at CALL time, and a second copy of the
// mapping here is how the two would eventually disagree about what a tool
// needs.
const SD_READ = 'read:request:jira-service-management';
const SD_WRITE = 'write:request:jira-service-management';
const CUSTOMER_READ = 'read:customer:jira-service-management';
const CUSTOMER_WRITE = 'write:customer:jira-service-management';

function serviceDeskScopes(_toolName: string, readOnly: boolean): string[] {
  return readOnly ? [SD_READ] : [SD_READ, SD_WRITE];
}

function customerScopes(_toolName: string, readOnly: boolean): string[] {
  return readOnly ? [CUSTOMER_READ] : [CUSTOMER_READ, CUSTOMER_WRITE];
}

export async function registerJiraServiceManagementTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  const scopes = context.grantedScopes;
  await registerJsmTools(withScopeGate(server, scopes, serviceDeskScopes), context);
  await registerRequestDetailsTools(withScopeGate(server, scopes, serviceDeskScopes), context);
  await registerJsmCustomerTools(withScopeGate(server, scopes, customerScopes), context);
  // Production's one and only auth: the caller's real OAuth grant. Anything
  // else (a personal token against a sandbox) is injected by whoever calls
  // registerJsmOpsTools directly — see ops.integration.test.ts.
  await registerJsmOpsTools(
    withScopeGate(server, scopes, opsScopes),
    context,
    oauthJsmOpsAuth(context)
  );
}

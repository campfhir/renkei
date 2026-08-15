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
import { serviceDeskScopes, customerScopes, oauthJsmAuth } from './jsm-auth';
import { withScopeGate } from '../capability-gate';

export async function registerJiraServiceManagementTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  const scopes = context.grantedScopes;
  // Production's one and only auth for each family: the caller's real OAuth
  // grant. Anything else (a personal token against a sandbox) is injected by
  // whoever calls these register functions directly — see
  // jsm.integration.test.ts and ops.integration.test.ts.
  const auth = oauthJsmAuth(context);
  await registerJsmTools(withScopeGate(server, scopes, serviceDeskScopes), context, auth);
  await registerRequestDetailsTools(
    withScopeGate(server, scopes, serviceDeskScopes),
    context,
    auth
  );
  await registerJsmCustomerTools(withScopeGate(server, scopes, customerScopes), context, auth);
  await registerJsmOpsTools(
    withScopeGate(server, scopes, opsScopes),
    context,
    oauthJsmOpsAuth(context)
  );
}

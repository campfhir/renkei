/**
 * Entra Developer MCP tools (entra_*), over the caller's own grant on the
 * SECOND Entra app registration ("Renkei Entra Developer"). Its own
 * connector and capability key — the jira-admin/onbase-admin arrangement —
 * so an org admin can switch it off or limit its audience (developers,
 * app owners) without touching anyone's Microsoft 365, and a tool whose
 * delegated scope the grant lacks is never registered (entraScopeFor in
 * ./scopes.ts).
 *
 * What it covers: app registrations and enterprise applications (create,
 * read, change), app roles (add, remove), who holds each role (assign
 * users and groups, remove them), and API permissions both ways (what an
 * app requests of Graph or another API, and the scopes it exposes) — the
 * provisioning a developer or app owner does in the Entra portal, with
 * every write preview + confirm on the directory_action_preview card.
 * Secrets and admin consent stay on the portal, one deep link away
 * (./portal.ts). Entra remains the authority: who may
 * create applications and who owns one are checked by Graph on every call.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';
import { entraScopeFor } from './scopes';
import type { EntraAuth } from './entra-auth';
import { registerReadTools } from './applications';
import { registerProvisionTools } from './provision';
import { registerAssignmentTools } from './assignments';
import { registerPermissionTools } from './permissions';

export const ENTRA_DEVELOPER_MCP_CONNECTOR = 'entra-developer';

export async function registerEntraDeveloperTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: EntraAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.entraDeveloperScopes, (name) =>
    entraScopeFor(name)
  );

  await registerReadTools(server, context, auth);
  await registerProvisionTools(server, context, auth);
  await registerAssignmentTools(server, context, auth);
  await registerPermissionTools(server, context, auth);
}

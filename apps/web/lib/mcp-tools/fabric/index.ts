/**
 * Microsoft Fabric MCP tools (fabric_*), over the caller's own grant on the
 * THIRD Entra app registration ("Renkei Microsoft Fabric"). Its own
 * connector and capability key, so an org admin can switch it off or limit
 * its audience to the data team without touching anyone's Microsoft 365,
 * and a tool whose delegated scope the grant lacks is never registered
 * (fabricScopeFor in ./scopes.ts).
 *
 * What it covers: workspaces (list, read, create, rename), what is in one
 * (items, a lakehouse's tables, capacities to put one on), and notebooks
 * and data pipelines (read their definitions — a long-running operation in
 * Fabric, kept as a Fabric operation row that a page streams and the
 * worker finishes, ./definitions.ts). Nothing here writes to Fabric:
 * changes are pull requests on a code project (./proposals.ts) — items in
 * Fabric's git format, and each environment's workspace in the project's
 * pipeline — deployed when merged, by the "Fabric: deploy items" block.
 * Querying data and OneLake files come later.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';
import { fabricScopeFor } from './scopes';
import type { FabricAuth } from './fabric-auth';
import { registerReadTools } from './reads';
import { registerDefinitionTools } from './definitions';
import { registerProposalTools } from './proposals';

export const FABRIC_MCP_CONNECTOR = 'fabric';

export async function registerFabricTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: FabricAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.fabricScopes, (name) => fabricScopeFor(name));
  await registerReadTools(server, context, auth);
  await registerDefinitionTools(server, context, auth);
  await registerProposalTools(server, context, auth);
}

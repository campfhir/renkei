/**
 * The SharePoint MCP namespace.
 *
 * A separate capability connector from Outlook even though both ride the one
 * Microsoft grant: an org-admin disabling SharePoint must not take mail down
 * with it, and "this user has SharePoint" is a different fact from "this user
 * has mail".
 *
 * How each call authenticates is an injected `GraphAuth` (see
 * graph/graph-auth.ts) — production always passes `oauthGraphAuth`; the
 * "no-sandbox" test suites pass `deniedGraphAuth` instead, since Graph is
 * delegated-OAuth-only with no personal-token equivalent to test against for
 * real yet.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { withScopeGate } from '../capability-gate';
import { registerDocumentTools } from '../graph/documents';
import type { GraphAuth } from '../graph/graph-auth';
import { registerSiteTools } from './sites';
import { registerPageTools } from './pages';
import { registerMetadataTools } from './metadata';
import { registerWatchTools } from './watches';
import { sharepointScopeFor } from './scopes';

export const SHAREPOINT_MCP_CONNECTOR = 'sharepoint';

export async function registerSharePointTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.graphScopes, (name) => sharepointScopeFor(name));

  registerSiteTools(server, context, auth);
  registerPageTools(server, context, auth);
  registerMetadataTools(server, context, auth);
  registerWatchTools(server, context, auth);
  registerDocumentTools(server, context, auth, {
    prefix: 'sharepoint',
    title: 'SharePoint',
    // SharePoint has no default drive: guessing one would act on the wrong
    // library silently, so a site (or an explicit driveId) is required.
    usesMyDrive: false,
  });
}

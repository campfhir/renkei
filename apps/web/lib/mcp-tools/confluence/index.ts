/**
 * Confluence MCP tools, over the caller's own delegated grant on the third
 * Atlassian app ("Renkei Confluence"). Split by resource area (spaces,
 * pages, blog posts, comments, labels, tasks, attachments, databases,
 * whiteboards, search, analytics) — mirrors the Jira tool directory's
 * split, since the tool count here is comparably large.
 *
 * A tool whose required scope(s) the caller's grant does not carry is not
 * registered at all — the org may have narrowed the checkboxes, or the
 * user narrowed their own connect. See confluenceScopeFor in ./scopes.ts.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';
import { confluenceScopeFor } from './scopes';
import { registerSpaceTools } from './spaces';
import { registerSearchTools } from './search';
import { registerPageTools } from './pages';
import { registerBlogpostTools } from './blogposts';
import { registerLabelTools } from './labels';
import { registerCommentTools } from './comments';
import { registerTaskTools } from './tasks';
import { registerAttachmentTools } from './attachments';
import { registerDatabaseTools } from './databases';
import { registerWhiteboardTools } from './whiteboards';
import { registerAnalyticsTools } from './analytics';

export const CONFLUENCE_MCP_CONNECTOR = 'atlassian-confluence';

export async function registerConfluenceTools(
  rawServer: McpServer,
  context: MCPToolContext
): Promise<void> {
  const server = withScopeGate(rawServer, context.confluenceScopes, (name) =>
    confluenceScopeFor(name)
  );

  await registerSpaceTools(server, context);
  await registerSearchTools(server, context);
  await registerPageTools(server, context);
  await registerBlogpostTools(server, context);
  await registerLabelTools(server, context);
  await registerCommentTools(server, context);
  await registerTaskTools(server, context);
  await registerAttachmentTools(server, context);
  await registerDatabaseTools(server, context);
  await registerWhiteboardTools(server, context);
  await registerAnalyticsTools(server, context);
}

/**
 * Bitbucket Cloud MCP tools, over the caller's own delegated grant on the
 * fourth Atlassian app ("Renkei Bitbucket"). Split by resource area —
 * repositories & code, pull requests, pipelines — mirroring the Confluence
 * directory's split.
 *
 * A tool whose required scope(s) the connection does not carry is not
 * registered at all. The gated set is requested ∩ granted (computed in
 * registry.ts): Bitbucket fixes scopes on the OAuth consumer, so the
 * token always carries the consumer's full set and only the user's
 * requested narrowing can shrink it — the Zoom arrangement, not the
 * Atlassian one.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';
import { bitbucketScopeFor } from './scopes';
import type { BitbucketAuth } from './bitbucket-auth';
import { registerRepositoryTools } from './repositories';
import { registerPullRequestTools } from './pullrequests';
import { registerPipelineTools } from './pipelines';

export const BITBUCKET_MCP_CONNECTOR = 'atlassian-bitbucket';

export async function registerBitbucketTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: BitbucketAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.bitbucketScopes, (name) =>
    bitbucketScopeFor(name)
  );

  await registerRepositoryTools(server, context, auth);
  await registerPullRequestTools(server, context, auth);
  await registerPipelineTools(server, context, auth);
}

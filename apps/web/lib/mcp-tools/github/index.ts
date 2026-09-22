/**
 * GitHub MCP tools, over the caller's own delegated grant on Renkei's
 * GitHub App. Split by resource area — repositories & code, pull
 * requests, Actions, repository access — mirroring the Bitbucket
 * directory's split.
 *
 * A tool whose required capability(ies) the connection does not carry is
 * not registered at all. The gated set is requested ∩ granted (computed
 * in registry.ts): a GitHub App's real permissions are fixed on the
 * App's own registration, not requested at authorize time, so the token
 * always carries whatever the App was configured with and only the
 * user's requested narrowing can shrink what Renkei uses — the
 * Zoom/Bitbucket arrangement, not the Atlassian one.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';
import { githubScopeFor } from './scopes';
import type { GitHubAuth } from './github-auth';
import { registerRepositoryTools } from './repositories';
import { registerPullRequestTools } from './pullrequests';
import { registerActionsTools } from './actions';
import { registerPermissionTools } from './permissions';

export const GITHUB_MCP_CONNECTOR = 'github';

export async function registerGitHubTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: GitHubAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.githubScopes, (name) => githubScopeFor(name));

  await registerRepositoryTools(server, context, auth);
  await registerPullRequestTools(server, context, auth);
  await registerActionsTools(server, context, auth);
  await registerPermissionTools(server, context, auth);
}

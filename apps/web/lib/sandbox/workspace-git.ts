/**
 * How a code workspace reaches Bitbucket: the person's own delegated
 * grant, turned into the one thing git needs for a clone, a pull or a
 * push — an Authorization header — for the length of one worker call.
 *
 * Bitbucket Cloud accepts an OAuth access token over git-https as Basic
 * auth with the fixed username `x-token-auth`. The header is built here,
 * forwarded to the sandbox worker in the request body, and put in that
 * one git process's environment; it is never in a URL, never on disk,
 * never in a tool result. The same resolver serves the MCP tools and the
 * connectors page's clone form, so both stand on the same scope checks.
 */

import { resolveBitbucketAccess } from '@/lib/mcp-tools/bitbucket/client';
import type { MCPToolContext } from '@/lib/mcp-tools/common';

export interface WorkspaceGitCredential {
  authHeader: string;
  username: string;
}

/**
 * The grant as a git credential, or the refusal to relay. `scopes` is
 * the connection's requested ∩ granted set when known — the same
 * narrowing the bitbucket_* tools enforce — and `write` asks for
 * `repository:write` (a push) rather than `repository` (a clone or pull).
 */
export async function resolveWorkspaceGitCredential(
  context: Pick<MCPToolContext, 'tenantId' | 'subject' | 'origin'> & { bitbucketScopes?: string[] },
  options: { write: boolean }
): Promise<WorkspaceGitCredential | string> {
  const needed = options.write ? 'repository:write' : 'repository';
  if (context.bitbucketScopes !== undefined && !context.bitbucketScopes.includes(needed)) {
    return (
      `This needs the Bitbucket "${needed}" capability, which this connection does not carry. ` +
      `Reconnect Bitbucket on the Connectors page with ${options.write ? 'code write' : 'code read'} enabled.`
    );
  }
  const access = await resolveBitbucketAccess(context);
  if (typeof access === 'string') return access;
  return {
    authHeader: `Basic ${Buffer.from(`x-token-auth:${access.accessToken}`, 'utf8').toString('base64')}`,
    username: access.username,
  };
}

/** The https clone URL for `workspace/repo` on Bitbucket Cloud. */
export function bitbucketCloneUrl(workspace: string, repoSlug: string): string {
  return `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}.git`;
}

/** The commit author for a person: their org email when known, else a no-reply address on their Bitbucket username. */
export function commitAuthorFor(
  username: string,
  userEmail: string | undefined
): { name: string; email: string } {
  return {
    name: username || 'Renkei',
    email: userEmail || `${username || 'renkei'}@users.noreply.bitbucket.org`,
  };
}

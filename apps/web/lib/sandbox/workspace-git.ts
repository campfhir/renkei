/**
 * How a code workspace reaches its git host: the person's own delegated
 * grant, turned into the one thing git needs for a clone, a pull or a
 * push — an Authorization header — for the length of one worker call.
 * `resolveWorkspaceGitCredential` dispatches on the project's
 * `repo.provider` (migration 102's `repo_provider`, one of
 * ATLASSIAN_BITBUCKET or GITHUB) to the matching provider's own
 * resolver, so a code project works the same way whichever host its
 * repository lives on — this module is the one seam that knows both.
 *
 * Bitbucket Cloud accepts an OAuth access token over git-https as Basic
 * auth with the fixed username `x-token-auth`; GitHub accepts a GitHub
 * App user-to-server token the same way with the fixed username
 * `x-access-token` (both documented conventions of their respective
 * providers — see e.g. GitHub's "Cloning a repository ... with a token").
 * The header is built here, forwarded to the sandbox worker in the
 * request body, and put in that one git process's environment; it is
 * never in a URL, never on disk, never in a tool result. The same
 * resolvers serve the MCP tools and the connectors page's clone form, so
 * both stand on the same scope checks.
 */

import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { resolveBitbucketAccess } from '@/lib/mcp-tools/bitbucket/client';
import { resolveGitHubAccess } from '@/lib/mcp-tools/github/client';
import type { MCPToolContext } from '@/lib/mcp-tools/common';

export interface WorkspaceGitCredential {
  authHeader: string;
  username: string;
}

type GitContext = Pick<MCPToolContext, 'tenantId' | 'subject' | 'origin'> & {
  provider: string;
  bitbucketScopes?: string[];
  githubScopes?: string[];
};

/**
 * The grant as a git credential, or the refusal to relay — dispatched by
 * `context.provider` to the matching host's own scope rule. `write` asks
 * for the host's write-level repository scope (a push) rather than its
 * read-level one (a clone or pull).
 */
export async function resolveWorkspaceGitCredential(
  context: GitContext,
  options: { write: boolean }
): Promise<WorkspaceGitCredential | string> {
  if (context.provider === GITHUB) return resolveGitHubWorkspaceGitCredential(context, options);
  if (context.provider === ATLASSIAN_BITBUCKET) {
    return resolveBitbucketWorkspaceGitCredential(context, options);
  }
  return `Unknown repository provider "${context.provider}".`;
}

async function resolveBitbucketWorkspaceGitCredential(
  context: GitContext,
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

async function resolveGitHubWorkspaceGitCredential(
  context: GitContext,
  options: { write: boolean }
): Promise<WorkspaceGitCredential | string> {
  const needed = options.write ? 'repository:write' : 'repository';
  if (context.githubScopes !== undefined && !context.githubScopes.includes(needed)) {
    return (
      `This needs the GitHub "${needed}" capability, which this connection does not carry. ` +
      `Reconnect GitHub on the Connectors page with ${options.write ? 'code write' : 'code read'} enabled.`
    );
  }
  const access = await resolveGitHubAccess(context);
  if (typeof access === 'string') return access;
  return {
    authHeader: `Basic ${Buffer.from(`x-access-token:${access.accessToken}`, 'utf8').toString('base64')}`,
    username: access.login,
  };
}

/** The https clone URL for `workspace/repo` on Bitbucket Cloud. */
export function bitbucketCloneUrl(workspace: string, repoSlug: string): string {
  return `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}.git`;
}

/** The https clone URL for `owner/repo` on GitHub. */
export function githubCloneUrl(owner: string, repo: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
}

/** The clone URL for `owner/repo` (or `workspace/repo`) on the given provider. */
export function cloneUrlFor(provider: string, owner: string, repo: string): string {
  return provider === GITHUB ? githubCloneUrl(owner, repo) : bitbucketCloneUrl(owner, repo);
}

/**
 * The commit author for a person: their org email when known, else a
 * no-reply address on their username at the repository's own host.
 */
export function commitAuthorFor(
  username: string,
  userEmail: string | undefined,
  provider: string = ATLASSIAN_BITBUCKET
): { name: string; email: string } {
  const domain = provider === GITHUB ? 'users.noreply.github.com' : 'users.noreply.bitbucket.org';
  return {
    name: username || 'Renkei',
    email: userEmail || `${username || 'renkei'}@${domain}`,
  };
}

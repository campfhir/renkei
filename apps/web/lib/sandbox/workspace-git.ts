/**
 * How a code workspace reaches its git host: the person's own delegated
 * grant, turned into the one thing git needs for a clone, a pull or a
 * push — an Authorization header — for the length of one worker call.
 * `resolveWorkspaceGitCredential` dispatches on the project's
 * `repo.provider` (migration 102's `repo_provider`, one of
 * ATLASSIAN_BITBUCKET or GITHUB) to the matching provider's own scope
 * rule, then asks the delegate for the header (`grant/git-credential`),
 * so a code project works the same way whichever host its repository
 * lives on — this module is the one seam that knows both.
 *
 * This is the one documented exception to "tokens never leave the
 * delegate" (docs/delegate-key-design.md, "Phase 1 as built"): Bitbucket
 * Cloud accepts an OAuth access token over git-https as Basic auth with
 * the fixed username `x-token-auth`; GitHub accepts a GitHub App
 * user-to-server token the same way with the fixed username
 * `x-access-token`. The delegate builds that header and logs every issue;
 * it is forwarded to the sandbox worker in the request body and put in
 * that one git process's environment — never in a URL, never on disk,
 * never in a tool result. To be replaced by a git proxy with short-lived
 * tickets.
 */

import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import { grantRefusalText } from '@/lib/grant-refusals';

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
  if (context.provider === GITHUB) {
    return resolveHostGitCredential(context, options, {
      scopes: context.githubScopes,
      label: 'GitHub',
    });
  }
  if (context.provider === ATLASSIAN_BITBUCKET) {
    return resolveHostGitCredential(context, options, {
      scopes: context.bitbucketScopes,
      label: 'Bitbucket',
    });
  }
  return `Unknown repository provider "${context.provider}".`;
}

async function resolveHostGitCredential(
  context: GitContext,
  options: { write: boolean },
  host: { scopes: string[] | undefined; label: string }
): Promise<WorkspaceGitCredential | string> {
  const needed = options.write ? 'repository:write' : 'repository';
  if (host.scopes !== undefined && !host.scopes.includes(needed)) {
    return (
      `This needs the ${host.label} "${needed}" capability, which this connection does not carry. ` +
      `Reconnect ${host.label} on the Connectors page with ${options.write ? 'code write' : 'code read'} enabled.`
    );
  }
  if (!context.subject) return 'No signed-in subject on this request.';
  const credential = await delegateGrants().gitCredential({
    tenantId: context.tenantId,
    provider: context.provider,
    subject: context.subject,
  });
  if (!credential.ok) {
    return credential.err.type === 'GRANT_UNREADABLE' || credential.err.type === 'DELEGATE_ERROR'
      ? `Could not read the ${host.label} grant.`
      : grantRefusalText(credential.err.type, host.label);
  }
  return { authHeader: credential.val.authHeader, username: credential.val.login ?? '' };
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

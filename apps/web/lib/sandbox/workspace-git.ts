/**
 * How a code workspace reaches its git host: through the delegate
 * (docs/delegate-key-design.md). `resolveWorkspaceGitAccess` dispatches on
 * the project's `repo.provider` (migration 102's `repo_provider`, one of
 * ATLASSIAN_BITBUCKET or GITHUB) to the matching provider's own scope
 * rule, then asks the delegate for a git TICKET (`grant/git-ticket`): a
 * proxy base the sandbox worker's git uses in place of the host for the
 * one clone, pull or push. The delegate attaches the person's token on the
 * way to GitHub or Bitbucket; the sandbox holds no credential at all, and
 * nothing of the person's outlives the call — the ticket is bound to one
 * person, one host and one direction, and expires in minutes.
 */

import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { delegateGrants, type GitProxy } from '@renkei/delegate-client';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import { grantRefusalText } from '@/lib/grant-refusals';

export interface WorkspaceGitAccess {
  /** Where git goes instead of the host, for this one operation. */
  gitProxy: GitProxy;
  username: string;
}

type GitContext = Pick<MCPToolContext, 'subject' | 'origin'> & {
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
export async function resolveWorkspaceGitAccess(
  context: GitContext,
  options: { write: boolean }
): Promise<WorkspaceGitAccess | string> {
  if (context.provider === GITHUB) {
    return resolveHostGitAccess(context, options, {
      scopes: context.githubScopes,
      label: 'GitHub',
    });
  }
  if (context.provider === ATLASSIAN_BITBUCKET) {
    return resolveHostGitAccess(context, options, {
      scopes: context.bitbucketScopes,
      label: 'Bitbucket',
    });
  }
  return `Unknown repository provider "${context.provider}".`;
}

async function resolveHostGitAccess(
  context: GitContext,
  options: { write: boolean },
  host: { scopes: string[] | undefined; label: string }
): Promise<WorkspaceGitAccess | string> {
  const needed = options.write ? 'repository:write' : 'repository';
  if (host.scopes !== undefined && !host.scopes.includes(needed)) {
    return (
      `This needs the ${host.label} "${needed}" capability, which this connection does not carry. ` +
      `Reconnect ${host.label} on the Connectors page with ${options.write ? 'code write' : 'code read'} enabled.`
    );
  }
  if (!context.subject) return 'No signed-in subject on this request.';
  const grants = delegateGrants();
  const [ticket, described] = await Promise.all([
    grants.gitTicket({
      provider: context.provider,
      subject: context.subject,
      write: options.write,
    }),
    grants.describe({
      provider: context.provider,
      subject: context.subject,
    }),
  ]);
  if (!ticket.ok) {
    return ticket.err.type === 'GRANT_UNREADABLE' || ticket.err.type === 'DELEGATE_ERROR'
      ? `Could not read the ${host.label} grant.`
      : grantRefusalText(ticket.err.type, host.label);
  }
  const metadata = described.ok ? described.val.metadata : {};
  const username =
    typeof metadata.login === 'string'
      ? metadata.login
      : typeof metadata.username === 'string'
        ? metadata.username
        : '';
  return { gitProxy: ticket.val, username };
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

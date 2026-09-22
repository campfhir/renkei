/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Repository access management. GitHub has no grouping above a
 * repository the way Bitbucket has projects — repositories sit directly
 * under an organization or user account — so this module covers only
 * what carries over: a repository's collaborators and their permission.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { actMeta } from '@renkei/tool-outcomes';
import type { MCPToolContext } from '../common';
import type { GitHubAuth } from './github-auth';
import { arr, describeGitHubFailure, errText, ghJson, moreLine, repoUrl, str, textResult } from './client';
import { githubScopeFor } from './scopes';

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

const ownerArg = z.string().min(1).describe('Account (organization or user) login, from github_list_accounts');
const repoArg = z.string().min(1).describe('Repository name, from github_list_repositories');

export async function registerPermissionTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GitHubAuth
): Promise<void> {
  server.registerTool(
    'github_list_repository_collaborators',
    {
      title: 'GitHub · Read — List a repository’s collaborators',
      description: 'Who has access to a repository, with their permission level (pull, triage, push, maintain, admin).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        max: z.number().int().min(1).max(100).describe('How many (default 50)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 50;
      const result = await ghJson(
        auth,
        githubScopeFor('github_list_repository_collaborators'),
        `${repoPath(str(args.owner), str(args.repo))}/collaborators?per_page=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = arr(result.body).map(
        (collaborator) => `${str(collaborator.login)} — ${str(collaborator.role_name) || 'collaborator'}`
      );
      if (lines.length === 0) return textResult('No collaborators.');
      return textResult(lines.join('\n') + moreLine(result.hasMore, 'raise max to see more.'));
    }
  );

  server.registerTool(
    'github_grant_repository_permission',
    {
      title: 'GitHub · Act — Grant repository access',
      description: 'Add a collaborator to a repository (or change the level they already hold).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        username: z.string().min(1).describe('The GitHub login to grant access to'),
        permission: z
          .enum(['pull', 'triage', 'push', 'maintain', 'admin'])
          .describe('The level to grant'),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const username = str(args.username);
      const result = await ghJson(
        auth,
        githubScopeFor('github_grant_repository_permission'),
        `${repoPath(owner, repo)}/collaborators/${encodeURIComponent(username)}`,
        { method: 'PUT', json: { permission: str(args.permission) } }
      );
      if (!result.ok) return errText(result.error);
      const url = repoUrl(owner, repo);
      return {
        content: [
          { type: 'text' as const, text: `Granted ${str(args.permission)} on ${repo} to ${username}.` },
        ],
        _meta: actMeta({ id: username, url: `${url}/settings/access` }),
      };
    }
  );

  server.registerTool(
    'github_revoke_repository_permission',
    {
      title: 'GitHub · Act — Revoke repository access',
      description: 'Remove a collaborator’s access to a repository. Access held another way — org-wide or via a team — is untouched.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        username: z.string().min(1).describe('The GitHub login to remove'),
      }),
    },
    async (args: Record<string, any>) => {
      const username = str(args.username);
      const response = await auth.fetch(
        githubScopeFor('github_revoke_repository_permission'),
        `${repoPath(str(args.owner), str(args.repo))}/collaborators/${encodeURIComponent(username)}`,
        { method: 'DELETE' }
      );
      if (!response.ok) return errText(await describeGitHubFailure(response));
      return {
        content: [{ type: 'text' as const, text: `Revoked ${username}'s access to ${str(args.repo)}.` }],
        _meta: actMeta({ id: username }),
      };
    }
  );
}

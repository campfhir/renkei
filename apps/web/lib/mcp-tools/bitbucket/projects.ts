/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Project administration and access management.
 *
 * One asymmetry runs through this file, imposed by Bitbucket rather than
 * chosen here: PROJECT-level permission WRITES refuse OAuth outright
 * ("integrations and add-ons are not allowed to change permissions" — the
 * spec's words), while project create/update/delete, every permission
 * READ, and REPOSITORY-level permission writes all take OAuth normally.
 * So granting someone access happens per repository here; the project
 * permission tools list honestly and say where the write lives.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { actMeta } from '@renkei/tool-outcomes';
import type { MCPToolContext } from '../common';
import type { BitbucketAuth } from './bitbucket-auth';
import {
  bbJson,
  describeBitbucketFailure,
  errText,
  moreLine,
  rec,
  repoUrl,
  str,
  textResult,
  values,
} from './client';
import { bitbucketScopeFor } from './scopes';

const workspaceArg = z.string().min(1).describe('Workspace slug, from bitbucket_list_workspaces');
const repoArg = z.string().min(1).describe('Repository slug, from bitbucket_list_repositories');
const projectKeyArg = z
  .string()
  .min(1)
  .describe('Project key, e.g. "MOBILE", from bitbucket_list_projects');

function projectPath(workspace: string, projectKey: string): string {
  return `/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(projectKey)}`;
}

function repoPath(workspace: string, repoSlug: string): string {
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

function projectUrl(workspace: string, projectKey: string): string {
  return `https://bitbucket.org/${encodeURIComponent(workspace)}/workspace/projects/${encodeURIComponent(projectKey)}`;
}

/**
 * The one line that stops an agent from retrying a write Bitbucket will
 * never take over OAuth, everywhere project permissions are surfaced.
 */
const PROJECT_WRITE_CAVEAT =
  'Bitbucket refuses PROJECT-permission changes from OAuth integrations — grant access per ' +
  'repository with bitbucket_grant_repository_permission, or change project permissions in ' +
  'the Bitbucket web UI.';

export async function registerProjectTools(
  server: McpServer,
  context: MCPToolContext,
  auth: BitbucketAuth
): Promise<void> {
  server.registerTool(
    'bitbucket_get_project',
    {
      title: 'Bitbucket · Read — Get a project',
      description: 'One project’s details: name, key, description, visibility.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ workspace: workspaceArg, projectKey: projectKeyArg }),
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const projectKey = str(args.projectKey);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_get_project'),
        projectPath(workspace, projectKey)
      );
      if (!result.ok) return errText(result.error);
      const project = result.body;
      return textResult(
        [
          `${str(project.name)} — key: ${str(project.key)}`,
          `Description: ${str(project.description) || '(none)'}`,
          `Visibility: ${project.is_private === false ? 'public' : 'private'}`,
          `Updated: ${str(project.updated_on)}`,
          '',
          `[Open in Bitbucket](${projectUrl(workspace, projectKey)})`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'bitbucket_create_project',
    {
      title: 'Bitbucket · Act — Create a project',
      description:
        'Create a project in a workspace — the grouping repositories are filed under. New ' +
        'repositories name it by key.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        name: z.string().min(1).describe('Project name'),
        key: z
          .string()
          .min(1)
          .describe('Project key — short, uppercase by convention, e.g. "MOBILE"'),
        description: z.string().describe('Project description').optional(),
        isPrivate: z.boolean().describe('Default true').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_create_project'),
        `/workspaces/${encodeURIComponent(workspace)}/projects`,
        {
          method: 'POST',
          json: {
            name: str(args.name),
            key: str(args.key),
            ...(str(args.description) ? { description: str(args.description) } : {}),
            is_private: args.isPrivate !== false,
          },
        }
      );
      if (!result.ok) return errText(result.error);
      const key = str(result.body.key);
      const url = projectUrl(workspace, key);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Created project ${str(result.body.name)} (${key}).\n\n[Open in Bitbucket](${url})`,
          },
        ],
        _meta: actMeta({ id: key, url }),
      };
    }
  );

  server.registerTool(
    'bitbucket_update_project',
    {
      title: 'Bitbucket · Act — Update a project',
      description:
        'Rename a project, change its description or visibility, or assign a new key. Only ' +
        'the fields passed change.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        projectKey: projectKeyArg,
        name: z.string().describe('New name').optional(),
        newKey: z.string().describe('New project key').optional(),
        description: z.string().describe('New description').optional(),
        isPrivate: z.boolean().describe('New visibility').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const projectKey = str(args.projectKey);
      // The PUT is an upsert wanting the full shape — read first and merge,
      // the same posture bitbucket_update_pull_request takes.
      const current = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_get_project'),
        projectPath(workspace, projectKey)
      );
      if (!current.ok) return errText(current.error);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_update_project'),
        projectPath(workspace, projectKey),
        {
          method: 'PUT',
          json: {
            name: str(args.name) || str(current.body.name),
            key: str(args.newKey) || str(current.body.key),
            ...(args.description !== undefined
              ? { description: str(args.description) }
              : str(current.body.description)
                ? { description: str(current.body.description) }
                : {}),
            is_private:
              typeof args.isPrivate === 'boolean'
                ? args.isPrivate
                : current.body.is_private !== false,
          },
        }
      );
      if (!result.ok) return errText(result.error);
      const key = str(result.body.key) || projectKey;
      const url = projectUrl(workspace, key);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated project ${str(result.body.name)} (${key}).\n\n[Open in Bitbucket](${url})`,
          },
        ],
        _meta: actMeta({ id: key, url }),
      };
    }
  );

  server.registerTool(
    'bitbucket_delete_project',
    {
      title: 'Bitbucket · Act — Delete a project',
      description:
        'Delete a project — irreversible. Bitbucket refuses while the project still contains ' +
        'repositories; move or delete them first.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ workspace: workspaceArg, projectKey: projectKeyArg }),
    },
    async (args: Record<string, any>) => {
      const projectKey = str(args.projectKey);
      const response = await auth.fetch(
        bitbucketScopeFor('bitbucket_delete_project'),
        projectPath(str(args.workspace), projectKey),
        { method: 'DELETE' }
      );
      if (!response.ok) return errText(await describeBitbucketFailure(response));
      return {
        content: [{ type: 'text' as const, text: `Deleted project ${projectKey}.` }],
        _meta: actMeta({ id: projectKey }),
      };
    }
  );

  server.registerTool(
    'bitbucket_list_workspace_members',
    {
      title: 'Bitbucket · Read — List workspace members',
      description: 'The people in a workspace, with the account ids the permission tools take.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        max: z.number().int().min(1).max(100).describe('How many (default 50)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 50;
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_workspace_members'),
        `/workspaces/${encodeURIComponent(str(args.workspace))}/members?pagelen=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map((membership) => {
        const user = rec(membership.user);
        return (
          `${str(user.display_name) || str(user.nickname)} — uuid: ${str(user.uuid)}` +
          (str(user.nickname) ? ` — nickname: ${str(user.nickname)}` : '')
        );
      });
      if (lines.length === 0) return textResult('No members.');
      return textResult(lines.join('\n') + moreLine(result.body, 'raise max to see more.'));
    }
  );

  server.registerTool(
    'bitbucket_list_project_permissions',
    {
      title: 'Bitbucket · Read — List a project’s explicit permissions',
      description:
        'Who has explicit access to a project — users and groups with their permission ' +
        'levels. Note: changing PROJECT permissions is refused for OAuth integrations by ' +
        'Bitbucket itself; grants happen per repository here.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ workspace: workspaceArg, projectKey: projectKeyArg }),
    },
    async (args: Record<string, any>) => {
      const base = projectPath(str(args.workspace), str(args.projectKey));
      const scopes = bitbucketScopeFor('bitbucket_list_project_permissions');
      const [users, groups] = await Promise.all([
        bbJson(auth, scopes, `${base}/permissions-config/users?pagelen=50`),
        bbJson(auth, scopes, `${base}/permissions-config/groups?pagelen=50`),
      ]);
      if (!users.ok) return errText(users.error);
      const lines = [
        ...values(users.body).map((entry) => {
          const user = rec(entry.user);
          return `${str(user.display_name)} — ${str(entry.permission)} — uuid: ${str(user.uuid)}`;
        }),
        // The group read is additive context; its failure costs the groups,
        // not the listing.
        ...(groups.ok
          ? values(groups.body).map(
              (entry) =>
                `group ${str(rec(entry.group).name) || str(rec(entry.group).slug)} — ${str(entry.permission)}`
            )
          : []),
      ];
      if (lines.length === 0) {
        return textResult(`No explicit project permissions.\n\n${PROJECT_WRITE_CAVEAT}`);
      }
      return textResult(`${lines.join('\n')}\n\n${PROJECT_WRITE_CAVEAT}`);
    }
  );

  server.registerTool(
    'bitbucket_list_repository_permissions',
    {
      title: 'Bitbucket · Read — List a repository’s explicit permissions',
      description:
        'Who has explicit access to a repository — users and groups with their permission ' +
        'levels (read, write, admin).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ workspace: workspaceArg, repoSlug: repoArg }),
    },
    async (args: Record<string, any>) => {
      const base = repoPath(str(args.workspace), str(args.repoSlug));
      const scopes = bitbucketScopeFor('bitbucket_list_repository_permissions');
      const [users, groups] = await Promise.all([
        bbJson(auth, scopes, `${base}/permissions-config/users?pagelen=50`),
        bbJson(auth, scopes, `${base}/permissions-config/groups?pagelen=50`),
      ]);
      if (!users.ok) return errText(users.error);
      const lines = [
        ...values(users.body).map((entry) => {
          const user = rec(entry.user);
          return `${str(user.display_name)} — ${str(entry.permission)} — uuid: ${str(user.uuid)}`;
        }),
        ...(groups.ok
          ? values(groups.body).map(
              (entry) =>
                `group ${str(rec(entry.group).name) || str(rec(entry.group).slug)} — ${str(entry.permission)}`
            )
          : []),
      ];
      if (lines.length === 0) return textResult('No explicit repository permissions.');
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'bitbucket_grant_repository_permission',
    {
      title: 'Bitbucket · Act — Grant repository access',
      description:
        'Grant a workspace member (or a group) read, write, or admin on one repository — or ' +
        'change the level they already hold. This is how access is given here: Bitbucket ' +
        'refuses PROJECT-permission changes from OAuth integrations. The user must already ' +
        'be a workspace member (bitbucket_list_workspace_members) and cannot be the ' +
        'workspace owner.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        userId: z
          .string()
          .describe(
            'Who: account uuid (braces optional), username, or Atlassian id — from ' +
              'bitbucket_list_workspace_members. Pass either userId or group, not both.'
          )
          .optional(),
        group: z.string().describe('Or: a workspace group slug').optional(),
        permission: z.enum(['read', 'write', 'admin']).describe('The level to grant'),
      }),
    },
    async (args: Record<string, any>) => {
      const target = permissionTarget(args);
      if ('error' in target) return errText(target.error);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_grant_repository_permission'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}${target.path}`,
        { method: 'PUT', json: { permission: str(args.permission) } }
      );
      if (!result.ok) return errText(result.error);
      const url = repoUrl(str(args.workspace), str(args.repoSlug));
      return {
        content: [
          {
            type: 'text' as const,
            text: `Granted ${str(args.permission)} on ${str(args.repoSlug)} to ${target.label}.`,
          },
        ],
        _meta: actMeta({ id: target.label, url: `${url}/admin/permissions` }),
      };
    }
  );

  server.registerTool(
    'bitbucket_revoke_repository_permission',
    {
      title: 'Bitbucket · Act — Revoke repository access',
      description:
        'Remove a user’s (or group’s) explicit permission on one repository. Access they ' +
        'hold another way — workspace-wide or via a group — is untouched.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        userId: z
          .string()
          .describe('Who: account uuid, username, or Atlassian id. Either userId or group.')
          .optional(),
        group: z.string().describe('Or: a workspace group slug').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const target = permissionTarget(args);
      if ('error' in target) return errText(target.error);
      const response = await auth.fetch(
        bitbucketScopeFor('bitbucket_revoke_repository_permission'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}${target.path}`,
        { method: 'DELETE' }
      );
      if (!response.ok) return errText(await describeBitbucketFailure(response));
      return {
        content: [
          {
            type: 'text' as const,
            text: `Revoked ${target.label}'s explicit access to ${str(args.repoSlug)}.`,
          },
        ],
        _meta: actMeta({ id: target.label }),
      };
    }
  );
}

/** userId XOR group → the permissions-config sub-path and a display label. */
function permissionTarget(
  args: Record<string, any>
): { path: string; label: string } | { error: string } {
  const userId = str(args.userId);
  const group = str(args.group);
  if ((userId && group) || (!userId && !group)) {
    return { error: 'Pass exactly one of userId or group.' };
  }
  return userId
    ? { path: `/permissions-config/users/${encodeURIComponent(userId)}`, label: userId }
    : { path: `/permissions-config/groups/${encodeURIComponent(group)}`, label: `group ${group}` };
}

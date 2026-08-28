/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Workspaces, projects, repositories, refs, commits, source and code
 * search — plus the two repository writes (branches and file commits).
 * Endpoint shapes: docs/bitbucket-cloud-rest-api-open-api-spec.json.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { actMeta } from '@renkei/tool-outcomes';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import type { BitbucketAuth } from './bitbucket-auth';
import {
  bbJson,
  bbRawText,
  describeBitbucketFailure,
  errText,
  moreLine,
  num,
  rec,
  repoUrl,
  str,
  textResult,
  values,
} from './client';
import { bitbucketScopeFor } from './scopes';

/** {workspace}/{repo_slug} path segment, both halves encoded. */
function repoPath(workspace: string, repoSlug: string): string {
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

const workspaceArg = z.string().min(1).describe('Workspace slug, from bitbucket_list_workspaces');
const repoArg = z.string().min(1).describe('Repository slug, from bitbucket_list_repositories');

function repoLine(repo: Record<string, unknown>): string {
  const project = str(rec(repo.project).key);
  return (
    `${str(repo.full_name) || str(repo.slug)}` +
    (project ? ` — project ${project}` : '') +
    ` — ${rec(repo).is_private === false ? 'public' : 'private'}` +
    (str(rec(repo.mainbranch).name) ? ` — main branch ${str(rec(repo.mainbranch).name)}` : '') +
    (str(repo.updated_on) ? ` — updated ${str(repo.updated_on)}` : '')
  );
}

function commitLine(commit: Record<string, unknown>): string {
  const author = rec(commit.author);
  const who = str(rec(author.user).display_name) || str(author.raw);
  const message = str(commit.message).split('\n', 1)[0];
  return `${str(commit.hash).slice(0, 12)} — ${who} — ${str(commit.date)}\n  ${message}`;
}

export async function registerRepositoryTools(
  server: McpServer,
  context: MCPToolContext,
  auth: BitbucketAuth
): Promise<void> {
  server.registerTool(
    'bitbucket_list_workspaces',
    {
      title: 'Bitbucket · Read — List workspaces',
      description:
        'List the Bitbucket workspaces the connected user is a member of. Workspace slugs feed ' +
        'every other tool.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const scopes = bitbucketScopeFor('bitbucket_list_workspaces');
      const result = await bbJson(auth, scopes, '/workspaces?pagelen=50');
      if (result.ok) {
        const lines = values(result.body).map(
          (workspace) =>
            `${str(workspace.name) || str(workspace.slug)} — slug: ${str(workspace.slug)}`
        );
        if (lines.length === 0) return textResult('No workspaces.');
        return textResult(lines.join('\n'));
      }
      // Observed in the field: a token that authenticates cleanly on every
      // workspace-scoped endpoint can still get the anonymous-style 404 on
      // bare /workspaces — Bitbucket masks endpoints that do not support a
      // token's TYPE as not-found rather than 401. The permissions listing
      // answers the same question and takes the newer tokens, so it is the
      // fallback; only if both refuse does the original error surface.
      const fallback = await bbJson(auth, scopes, '/user/permissions/workspaces?pagelen=50');
      if (!fallback.ok) return errText(result.error);
      const lines = values(fallback.body).map((row) => {
        const workspace = rec(row.workspace);
        return (
          `${str(workspace.name) || str(workspace.slug)} — slug: ${str(workspace.slug)}` +
          (str(row.permission) ? ` — your permission: ${str(row.permission)}` : '')
        );
      });
      if (lines.length === 0) return textResult('No workspaces.');
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'bitbucket_list_projects',
    {
      title: 'Bitbucket · Read — List projects in a workspace',
      description:
        'List the projects grouping a workspace’s repositories. Filter repositories by project ' +
        'with bitbucket_list_repositories’ query, e.g. project.key="MOBILE".',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 25;
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_projects'),
        `/workspaces/${encodeURIComponent(str(args.workspace))}/projects?pagelen=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (project) => `${str(project.name)} — key: ${str(project.key)}`
      );
      if (lines.length === 0) return textResult('No projects.');
      return textResult(
        lines.join('\n') + moreLine(result.body, 'raise max to see further pages.')
      );
    }
  );

  server.registerTool(
    'bitbucket_list_repositories',
    {
      title: 'Bitbucket · Read — List repositories',
      description:
        'List repositories in a workspace, most recently updated first. `query` is a Bitbucket ' +
        'filter expression, e.g. name ~ "api", project.key = "MOBILE" — quote strings with ' +
        'double quotes.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        query: z
          .string()
          .describe('Bitbucket filter expression (q=), e.g. name ~ "api"')
          .optional(),
        role: z
          .enum(['owner', 'admin', 'contributor', 'member'])
          .describe('Only repositories where the user has at least this role')
          .optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 25;
      const parts = [`pagelen=${max}`, 'sort=-updated_on'];
      if (str(args.query)) parts.push(`q=${encodeURIComponent(str(args.query))}`);
      if (str(args.role)) parts.push(`role=${str(args.role)}`);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_repositories'),
        `/repositories/${encodeURIComponent(str(args.workspace))}?${parts.join('&')}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(repoLine);
      if (lines.length === 0) return textResult('No repositories.');
      return textResult(
        withPresentationHint(
          lines.join('\n') + moreLine(result.body, 'narrow with query or raise max.'),
          'a table (Repository, Project, Main branch, Updated) usually scans faster than this ' +
            'flat list.'
        )
      );
    }
  );

  server.registerTool(
    'bitbucket_get_repository',
    {
      title: 'Bitbucket · Read — Get a repository',
      description: 'Full details for one repository: main branch, project, size, language.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ workspace: workspaceArg, repoSlug: repoArg }),
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const repoSlug = str(args.repoSlug);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_get_repository'),
        repoPath(workspace, repoSlug)
      );
      if (!result.ok) return errText(result.error);
      const repo = result.body;
      const lines = [
        `${str(repo.full_name)}`,
        `Description: ${str(repo.description) || '(none)'}`,
        `Project: ${str(rec(repo.project).name)} (${str(rec(repo.project).key)})`,
        `Main branch: ${str(rec(repo.mainbranch).name) || '(none)'}`,
        `Visibility: ${repo.is_private === false ? 'public' : 'private'}`,
        `Language: ${str(repo.language) || '(unset)'}`,
        `Updated: ${str(repo.updated_on)}`,
        '',
        `[Open in Bitbucket](${repoUrl(workspace, repoSlug)})`,
      ];
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'bitbucket_list_branches',
    {
      title: 'Bitbucket · Read — List branches',
      description:
        'List a repository’s branches, most recent head commit first. `query` filters by name, ' +
        'e.g. name ~ "feature".',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        query: z.string().describe('Bitbucket filter expression, e.g. name ~ "fix"').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 25;
      const parts = [`pagelen=${max}`, 'sort=-target.date'];
      if (str(args.query)) parts.push(`q=${encodeURIComponent(str(args.query))}`);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_branches'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/refs/branches?${parts.join('&')}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (branch) =>
          `${str(branch.name)} — head ${str(rec(branch.target).hash).slice(0, 12)}` +
          (str(rec(branch.target).date) ? ` — ${str(rec(branch.target).date)}` : '')
      );
      if (lines.length === 0) return textResult('No branches.');
      return textResult(
        lines.join('\n') + moreLine(result.body, 'narrow with query or raise max.')
      );
    }
  );

  server.registerTool(
    'bitbucket_list_tags',
    {
      title: 'Bitbucket · Read — List tags',
      description: 'List a repository’s tags, newest target commit first.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 25;
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_tags'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/refs/tags?pagelen=${max}&sort=-target.date`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (tag) => `${str(tag.name)} — ${str(rec(tag.target).hash).slice(0, 12)}`
      );
      if (lines.length === 0) return textResult('No tags.');
      return textResult(lines.join('\n') + moreLine(result.body, 'raise max to see more.'));
    }
  );

  server.registerTool(
    'bitbucket_list_commits',
    {
      title: 'Bitbucket · Read — List commits',
      description:
        'List commits on a branch (or from any ref), newest first — optionally only those ' +
        'touching one path.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        ref: z
          .string()
          .describe('Branch, tag, or commit to walk back from; default the main branch')
          .optional(),
        path: z.string().describe('Only commits touching this file or directory').optional(),
        max: z.number().int().min(1).max(50).describe('How many (default 15)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 15;
      const ref = str(args.ref);
      const parts = [`pagelen=${max}`];
      if (str(args.path)) parts.push(`path=${encodeURIComponent(str(args.path))}`);
      const base = `${repoPath(str(args.workspace), str(args.repoSlug))}/commits`;
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_commits'),
        `${base}${ref ? `/${encodeURIComponent(ref)}` : ''}?${parts.join('&')}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(commitLine);
      if (lines.length === 0) return textResult('No commits.');
      return textResult(lines.join('\n') + moreLine(result.body, 'raise max to walk further.'));
    }
  );

  server.registerTool(
    'bitbucket_get_commit',
    {
      title: 'Bitbucket · Read — Get a commit',
      description: 'One commit’s full message, author, parents, and per-file change stats.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        commit: z.string().min(1).describe('Commit hash (full or abbreviated)'),
      }),
    },
    async (args: Record<string, any>) => {
      const base = repoPath(str(args.workspace), str(args.repoSlug));
      const scopes = bitbucketScopeFor('bitbucket_get_commit');
      const commitHash = encodeURIComponent(str(args.commit));
      const [commitResult, statResult] = await Promise.all([
        bbJson(auth, scopes, `${base}/commit/${commitHash}`),
        bbJson(auth, scopes, `${base}/diffstat/${commitHash}?pagelen=50`),
      ]);
      if (!commitResult.ok) return errText(commitResult.error);
      const commit = commitResult.body;
      const author = rec(commit.author);
      const lines = [
        `Commit ${str(commit.hash)}`,
        `Author: ${str(rec(author.user).display_name) || str(author.raw)}`,
        `Date: ${str(commit.date)}`,
        '',
        str(commit.message).trim(),
      ];
      // The diffstat is additive context; its failure costs the stats, not
      // the commit.
      if (statResult.ok) {
        const stats = values(statResult.body).map((entry) => {
          const file = str(rec(entry.new).path) || str(rec(entry.old).path);
          return `  ${str(entry.status)} ${file} (+${num(entry.lines_added) || '0'}/-${num(entry.lines_removed) || '0'})`;
        });
        if (stats.length > 0) lines.push('', 'Files:', ...stats);
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'bitbucket_get_diff',
    {
      title: 'Bitbucket · Read — Diff two revisions',
      description:
        'The unified diff for a revision spec: one commit ("abc123"), or two dot-separated ' +
        '("feature..main" diffs feature against main). Large diffs are truncated — ' +
        'bitbucket_get_commit’s per-file stats scale better for a survey.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        spec: z.string().min(1).describe('Revision spec, e.g. "abc123" or "branch..main"'),
        path: z.string().describe('Limit the diff to this file').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const query = str(args.path) ? `?path=${encodeURIComponent(str(args.path))}` : '';
      const result = await bbRawText(
        auth,
        bitbucketScopeFor('bitbucket_get_diff'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/diff/${encodeURIComponent(str(args.spec))}${query}`
      );
      if (!result.ok) return errText(result.error);
      if (!result.text.trim()) return textResult('No differences.');
      const capped =
        result.text.length > 60_000
          ? `${result.text.slice(0, 60_000)}\n… (diff truncated at 60,000 characters)`
          : result.text;
      return textResult(capped);
    }
  );

  server.registerTool(
    'bitbucket_browse_source',
    {
      title: 'Bitbucket · Read — Browse a directory',
      description:
        'List the files and directories at a path in the repository, at a branch, tag, or ' +
        'commit. Read a file’s content with bitbucket_read_file.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        ref: z.string().min(1).describe('Branch, tag, or commit hash'),
        path: z.string().describe('Directory path; default the repository root').optional(),
        max: z.number().int().min(1).max(100).describe('How many entries (default 50)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 50;
      const path = str(args.path).replace(/^\/+/, '');
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_browse_source'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/src/${encodeURIComponent(str(args.ref))}/` +
          `${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}` +
          `${path ? '/' : ''}?pagelen=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map((entry) =>
        str(entry.type) === 'commit_directory'
          ? `${str(entry.path)}/`
          : `${str(entry.path)} (${num(entry.size) || '?'} bytes)`
      );
      if (lines.length === 0) return textResult('Empty directory.');
      return textResult(lines.join('\n') + moreLine(result.body, 'raise max to see more.'));
    }
  );

  server.registerTool(
    'bitbucket_read_file',
    {
      title: 'Bitbucket · Read — Read a file',
      description: 'The content of one file at a branch, tag, or commit.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        ref: z.string().min(1).describe('Branch, tag, or commit hash'),
        path: z.string().min(1).describe('File path within the repository'),
      }),
    },
    async (args: Record<string, any>) => {
      const path = str(args.path).replace(/^\/+/, '');
      const result = await bbRawText(
        auth,
        bitbucketScopeFor('bitbucket_read_file'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/src/${encodeURIComponent(str(args.ref))}/` +
          path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
      );
      if (!result.ok) return errText(result.error);
      const capped =
        result.text.length > 100_000
          ? `${result.text.slice(0, 100_000)}\n… (file truncated at 100,000 characters)`
          : result.text;
      return textResult(capped || '(empty file)');
    }
  );

  server.registerTool(
    'bitbucket_search_code',
    {
      title: 'Bitbucket · Read — Search code in a workspace',
      description:
        'Full-text code search across a workspace’s repositories. Supports the search ' +
        'operators Bitbucket’s own search box does, e.g. `repo:api-server ext:ts fetchUser`.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        query: z.string().min(1).describe('Search terms'),
        max: z.number().int().min(1).max(50).describe('How many matches (default 10)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 10;
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_search_code'),
        `/workspaces/${encodeURIComponent(str(args.workspace))}/search/code` +
          `?search_query=${encodeURIComponent(str(args.query))}&pagelen=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map((match) => {
        const file = rec(match.file);
        const repo = str(rec(rec(file.commit).repository).full_name);
        const snippets = Array.isArray(match.content_matches)
          ? match.content_matches
              .slice(0, 2)
              .flatMap((contentMatch) => {
                const matchLines = rec(contentMatch).lines;
                return Array.isArray(matchLines)
                  ? matchLines.map((line) => `    ${str(rec(line).segmentsText) || segmentsText(rec(line))}`)
                  : [];
              })
          : [];
        return [`${repo} — ${str(file.path)}`, ...snippets].join('\n');
      });
      if (lines.length === 0) return textResult('No matches.');
      return textResult(lines.join('\n\n') + moreLine(result.body, 'narrow the query.'));
    }
  );

  // ——— Writes ————————————————————————————————————————————————————————

  server.registerTool(
    'bitbucket_create_branch',
    {
      title: 'Bitbucket · Act — Create a branch',
      description: 'Create a branch at a commit (usually another branch’s head).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        name: z.string().min(1).describe('New branch name'),
        target: z
          .string()
          .min(1)
          .describe('Commit hash or branch name the new branch starts from'),
      }),
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const repoSlug = str(args.repoSlug);
      const name = str(args.name);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_create_branch'),
        `${repoPath(workspace, repoSlug)}/refs/branches`,
        { method: 'POST', json: { name, target: { hash: str(args.target) } } }
      );
      if (!result.ok) return errText(result.error);
      const url = `${repoUrl(workspace, repoSlug)}/branch/${encodeURIComponent(name)}`;
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Created branch ${str(result.body.name)} at ` +
              `${str(rec(result.body.target).hash).slice(0, 12)}\n\n[Open in Bitbucket](${url})`,
          },
        ],
        _meta: actMeta({ id: name, url }),
      };
    }
  );

  server.registerTool(
    'bitbucket_delete_branch',
    {
      title: 'Bitbucket · Act — Delete a branch',
      description:
        'Delete a branch. The commits stay reachable from anything else that references them, ' +
        'but the branch pointer is gone — there is no undo.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        name: z.string().min(1).describe('Branch name to delete'),
      }),
    },
    async (args: Record<string, any>) => {
      const name = str(args.name);
      const response = await auth.fetch(
        bitbucketScopeFor('bitbucket_delete_branch'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/refs/branches/${encodeURIComponent(name)}`,
        { method: 'DELETE' }
      );
      if (!response.ok) return errText(await describeBitbucketFailure(response));
      return {
        content: [{ type: 'text' as const, text: `Deleted branch ${name}.` }],
        _meta: actMeta({ id: name }),
      };
    }
  );

  server.registerTool(
    'bitbucket_commit_file',
    {
      title: 'Bitbucket · Act — Commit a file change',
      description:
        'Write one file and commit it to a branch in a single step — create or overwrite; ' +
        'parent directories appear as needed. For anything beyond a single text file, work ' +
        'through a clone instead.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        branch: z.string().min(1).describe('Branch to commit on (must exist)'),
        path: z.string().min(1).describe('File path within the repository'),
        content: z.string().describe('The full new file content'),
        message: z.string().min(1).describe('Commit message'),
      }),
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const repoSlug = str(args.repoSlug);
      const path = str(args.path).replace(/^\/+/, '');
      // The src endpoint takes a form post: file fields keyed by path,
      // message and branch alongside. Undocumented-but-real detail: the
      // response is 201 with no body.
      const form = new URLSearchParams();
      form.set(path, str(args.content));
      form.set('message', str(args.message));
      form.set('branch', str(args.branch));
      const response = await auth.fetch(
        bitbucketScopeFor('bitbucket_commit_file'),
        `${repoPath(workspace, repoSlug)}/src`,
        { method: 'POST', form }
      );
      if (!response.ok) return errText(await describeBitbucketFailure(response));
      const url = `${repoUrl(workspace, repoSlug)}/src/${encodeURIComponent(str(args.branch))}/${path}`;
      return {
        content: [
          {
            type: 'text' as const,
            text: `Committed ${path} to ${str(args.branch)}.\n\n[Open in Bitbucket](${url})`,
          },
        ],
        _meta: actMeta({ id: path, url }),
      };
    }
  );
}

/** search result lines carry {segments: [{text}]}; join defensively. */
function segmentsText(line: Record<string, unknown>): string {
  return Array.isArray(line.segments)
    ? line.segments.map((segment) => str(rec(segment).text)).join('')
    : '';
}

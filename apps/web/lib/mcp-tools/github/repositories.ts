/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Accounts (installations), repositories, refs, commits, source, code
 * search — plus the repository writes (branches and file commits).
 *
 * "Accounts" stands in for Bitbucket's workspaces: a GitHub App is
 * installed per organization or user account, and only repositories that
 * installation was granted reach this caller — so it is the natural unit
 * to list first, and every other tool resolves `owner` to an
 * installation behind the scenes (installationIdFor).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { actMeta } from '@renkei/tool-outcomes';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import type { GitHubAuth } from './github-auth';
import {
  arr,
  describeGitHubFailure,
  errText,
  ghJson,
  ghRawText,
  moreLine,
  num,
  rec,
  repoUrl,
  str,
  textResult,
} from './client';
import { githubScopeFor } from './scopes';

const ownerArg = z.string().min(1).describe('Account (organization or user) login, from github_list_accounts');
const repoArg = z.string().min(1).describe('Repository name, from github_list_repositories');
const RAW_ACCEPT = 'application/vnd.github.raw+json';
const DIFF_ACCEPT = 'application/vnd.github.v3.diff';

/** owner/repo path segment, both halves encoded. */
function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** A ref (branch/tag) as a path segment: slash-separated names encoded piecewise. */
function refSegment(ref: string): string {
  return ref
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function repoLine(repo: Record<string, unknown>): string {
  return (
    `${str(repo.full_name)}` +
    ` — ${repo.private === true ? 'private' : 'public'}` +
    (str(repo.default_branch) ? ` — default branch ${str(repo.default_branch)}` : '') +
    (str(repo.updated_at) ? ` — updated ${str(repo.updated_at)}` : '')
  );
}

function commitLine(commit: Record<string, unknown>): string {
  const inner = rec(commit.commit);
  const author = rec(inner.author);
  const who = str(rec(commit.author).login) || str(author.name);
  const message = str(inner.message).split('\n', 1)[0];
  return `${str(commit.sha).slice(0, 12)} — ${who} — ${str(author.date)}\n  ${message}`;
}

/**
 * `owner` resolves to the installation of Renkei's GitHub App that
 * covers it — found by listing the caller's accessible installations
 * (GET /user/installations) and matching the account login. Cached per
 * call site, never across calls: an admin adding/removing an
 * installation should be visible on the very next tool call.
 */
async function installationIdFor(
  auth: GitHubAuth,
  owner: string
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const result = await ghJson(auth, githubScopeFor('github_list_accounts'), '/user/installations?per_page=100');
  if (!result.ok) return result;
  const installations = arr(rec(result.body).installations);
  const match = installations.find(
    (installation) => str(rec(installation.account).login).toLowerCase() === owner.toLowerCase()
  );
  if (!match) {
    return {
      ok: false,
      error:
        `No installation of Renkei's GitHub App covers "${owner}" for this connection. ` +
        `Use github_list_accounts to see what is installed, or install the App on ${owner} ` +
        `from the Connectors page.`,
    };
  }
  return { ok: true, id: Number(match.id) };
}

export async function registerRepositoryTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GitHubAuth
): Promise<void> {
  server.registerTool(
    'github_list_accounts',
    {
      title: 'GitHub · Read — List accounts',
      description:
        'List the organizations and user accounts where Renkei’s GitHub App is installed for ' +
        'the connected user. Account logins feed every other tool as `owner`.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const result = await ghJson(
        auth,
        githubScopeFor('github_list_accounts'),
        '/user/installations?per_page=100'
      );
      if (!result.ok) return errText(result.error);
      const installations = arr(rec(result.body).installations);
      const lines = installations.map((installation) => {
        const account = rec(installation.account);
        return (
          `${str(account.login)} — ${str(account.type) || 'Organization'}` +
          (str(installation.repository_selection) === 'selected' ? ' — selected repositories' : ' — all repositories')
        );
      });
      if (lines.length === 0) {
        return textResult(
          'No installations. Install Renkei’s GitHub App on an organization or your own ' +
            'account from the Connectors page.'
        );
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'github_list_repositories',
    {
      title: 'GitHub · Read — List repositories',
      description:
        'List repositories the App’s installation on `owner` was granted, most recently ' +
        'updated first. `query` filters by a substring of the repository name.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        query: z.string().describe('Only repositories whose name contains this').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const installation = await installationIdFor(auth, owner);
      if (!installation.ok) return errText(installation.error);
      const max = typeof args.max === 'number' ? args.max : 25;
      const result = await ghJson(
        auth,
        githubScopeFor('github_list_repositories'),
        `/user/installations/${installation.id}/repositories?per_page=${max}`
      );
      if (!result.ok) return errText(result.error);
      let repos = arr(rec(result.body).repositories);
      const query = str(args.query).toLowerCase();
      if (query) repos = repos.filter((repo) => str(repo.name).toLowerCase().includes(query));
      repos.sort((a, b) => str(b.updated_at).localeCompare(str(a.updated_at)));
      const lines = repos.map(repoLine);
      if (lines.length === 0) return textResult('No repositories.');
      return textResult(
        withPresentationHint(
          lines.join('\n') + moreLine(result.hasMore && !query, 'raise max to see further pages.'),
          'a table (Repository, Visibility, Default branch, Updated) usually scans faster than ' +
            'this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'github_get_repository',
    {
      title: 'GitHub · Read — Get a repository',
      description: 'Full details for one repository: default branch, visibility, size, language.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ owner: ownerArg, repo: repoArg }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const result = await ghJson(auth, githubScopeFor('github_get_repository'), repoPath(owner, repo));
      if (!result.ok) return errText(result.error);
      const body = rec(result.body);
      const lines = [
        `${str(body.full_name)}`,
        `Description: ${str(body.description) || '(none)'}`,
        `Default branch: ${str(body.default_branch) || '(none)'}`,
        `Visibility: ${body.private === true ? 'private' : 'public'}`,
        `Language: ${str(body.language) || '(unset)'}`,
        `Updated: ${str(body.updated_at)}`,
        '',
        `[Open on GitHub](${repoUrl(owner, repo)})`,
      ];
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'github_list_branches',
    {
      title: 'GitHub · Read — List branches',
      description: 'List a repository’s branches. `query` filters by a substring of the name.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        query: z.string().describe('Only branches whose name contains this').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 25;
      const result = await ghJson(
        auth,
        githubScopeFor('github_list_branches'),
        `${repoPath(str(args.owner), str(args.repo))}/branches?per_page=${max}`
      );
      if (!result.ok) return errText(result.error);
      let branches = arr(result.body);
      const query = str(args.query).toLowerCase();
      if (query) branches = branches.filter((branch) => str(branch.name).toLowerCase().includes(query));
      const lines = branches.map(
        (branch) =>
          `${str(branch.name)} — head ${str(rec(branch.commit).sha).slice(0, 12)}` +
          (branch.protected === true ? ' — protected' : '')
      );
      if (lines.length === 0) return textResult('No branches.');
      return textResult(lines.join('\n') + moreLine(result.hasMore && !query, 'raise max to see more.'));
    }
  );

  server.registerTool(
    'github_list_tags',
    {
      title: 'GitHub · Read — List tags',
      description: 'List a repository’s tags.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 25;
      const result = await ghJson(
        auth,
        githubScopeFor('github_list_tags'),
        `${repoPath(str(args.owner), str(args.repo))}/tags?per_page=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = arr(result.body).map(
        (tag) => `${str(tag.name)} — ${str(rec(tag.commit).sha).slice(0, 12)}`
      );
      if (lines.length === 0) return textResult('No tags.');
      return textResult(lines.join('\n') + moreLine(result.hasMore, 'raise max to see more.'));
    }
  );

  server.registerTool(
    'github_list_commits',
    {
      title: 'GitHub · Read — List commits',
      description:
        'List commits on a branch (or from any ref), newest first — optionally only those ' +
        'touching one path.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        ref: z
          .string()
          .describe('Branch, tag, or commit to walk back from; default the default branch')
          .optional(),
        path: z.string().describe('Only commits touching this file or directory').optional(),
        max: z.number().int().min(1).max(50).describe('How many (default 15)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 15;
      const parts = [`per_page=${max}`];
      if (str(args.ref)) parts.push(`sha=${encodeURIComponent(str(args.ref))}`);
      if (str(args.path)) parts.push(`path=${encodeURIComponent(str(args.path))}`);
      const result = await ghJson(
        auth,
        githubScopeFor('github_list_commits'),
        `${repoPath(str(args.owner), str(args.repo))}/commits?${parts.join('&')}`
      );
      if (!result.ok) return errText(result.error);
      const lines = arr(result.body).map(commitLine);
      if (lines.length === 0) return textResult('No commits.');
      return textResult(lines.join('\n') + moreLine(result.hasMore, 'raise max to walk further.'));
    }
  );

  server.registerTool(
    'github_get_commit',
    {
      title: 'GitHub · Read — Get a commit',
      description: 'One commit’s full message, author, parents, and per-file change stats.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        commit: z.string().min(1).describe('Commit SHA (full or abbreviated)'),
      }),
    },
    async (args: Record<string, any>) => {
      const base = repoPath(str(args.owner), str(args.repo));
      const result = await ghJson(
        auth,
        githubScopeFor('github_get_commit'),
        `${base}/commits/${encodeURIComponent(str(args.commit))}`
      );
      if (!result.ok) return errText(result.error);
      const commit = rec(result.body);
      const inner = rec(commit.commit);
      const author = rec(inner.author);
      const lines = [
        `Commit ${str(commit.sha)}`,
        `Author: ${str(rec(commit.author).login) || str(author.name)}`,
        `Date: ${str(author.date)}`,
        '',
        str(inner.message).trim(),
      ];
      const files = arr(commit.files);
      if (files.length > 0) {
        lines.push(
          '',
          'Files:',
          ...files
            .slice(0, 100)
            .map((file) => `  ${str(file.status)} ${str(file.filename)} (+${num(file.additions) || '0'}/-${num(file.deletions) || '0'})`)
        );
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'github_get_diff',
    {
      title: 'GitHub · Read — Diff two revisions',
      description:
        'The unified diff for a revision spec: one commit ("abc123"), or two dot-separated ' +
        '("base...head" diffs head against base — the compare view). Large diffs are ' +
        'truncated — github_get_commit’s per-file stats scale better for a survey.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        spec: z.string().min(1).describe('Revision spec, e.g. "abc123" or "main...feature"'),
      }),
    },
    async (args: Record<string, any>) => {
      const base = repoPath(str(args.owner), str(args.repo));
      const spec = str(args.spec);
      const path = spec.includes('...')
        ? `${base}/compare/${spec.split('...').map(encodeURIComponent).join('...')}`
        : `${base}/commits/${encodeURIComponent(spec)}`;
      const result = await ghRawText(auth, githubScopeFor('github_get_diff'), path, DIFF_ACCEPT);
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
    'github_browse_source',
    {
      title: 'GitHub · Read — Browse a directory',
      description:
        'List the files and directories at a path in the repository, at a branch, tag, or ' +
        'commit. Read a file’s content with github_read_file, or several at once with ' +
        'github_read_files. Pass `maxDepth` > 1 to list an entire subtree in one call instead ' +
        'of one call per directory — the fast way to inventory a codebase before reviewing it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        ref: z.string().min(1).describe('Branch, tag, or commit SHA'),
        path: z.string().describe('Directory path; default the repository root').optional(),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(25)
          .describe(
            'Recurse this many directory levels deep in one call (default 1, that directory ' +
              'only). Use e.g. 25 to walk an entire subtree at once.'
          )
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const ref = str(args.ref);
      const path = str(args.path).replace(/^\/+|\/+$/g, '');
      const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 1;
      if (maxDepth <= 1) {
        const result = await ghJson(
          auth,
          githubScopeFor('github_browse_source'),
          `${repoPath(owner, repo)}/contents/${path ? refSegment(path) : ''}?ref=${encodeURIComponent(ref)}`
        );
        if (!result.ok) return errText(result.error);
        const entries = Array.isArray(result.body) ? arr(result.body) : [rec(result.body)];
        const lines = entries.map((entry) =>
          str(entry.type) === 'dir'
            ? `${str(entry.path)}/`
            : `${str(entry.path)} (${num(entry.size) || '?'} bytes)`
        );
        if (lines.length === 0) return textResult('Empty directory.');
        return textResult(lines.join('\n'));
      }
      // A recursive tree walk, for maxDepth > 1: one call over the whole ref,
      // filtered to the requested path prefix and depth.
      const treeResult = await ghJson(
        auth,
        githubScopeFor('github_browse_source'),
        `${repoPath(owner, repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`
      );
      if (!treeResult.ok) return errText(treeResult.error);
      const tree = rec(treeResult.body);
      const prefix = path ? `${path}/` : '';
      const baseDepth = path ? path.split('/').length : 0;
      const entries = arr(tree.tree).filter((entry) => {
        const entryPath = str(entry.path);
        if (path && entryPath !== path && !entryPath.startsWith(prefix)) return false;
        if (!path && !entryPath) return false;
        const depth = entryPath.split('/').length - baseDepth;
        return depth >= 1 && depth <= maxDepth;
      });
      const lines = entries.map((entry) =>
        str(entry.type) === 'tree'
          ? `${str(entry.path)}/`
          : `${str(entry.path)} (${num(entry.size) || '?'} bytes)`
      );
      if (lines.length === 0) return textResult('Empty directory.');
      return textResult(
        lines.join('\n') +
          (tree.truncated === true
            ? '\n\n(GitHub truncated this tree — it is unusually large; narrow the path.)'
            : '')
      );
    }
  );

  server.registerTool(
    'github_read_file',
    {
      title: 'GitHub · Read — Read a file',
      description: 'The content of one file at a branch, tag, or commit.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        ref: z.string().min(1).describe('Branch, tag, or commit SHA'),
        path: z.string().min(1).describe('File path within the repository'),
      }),
    },
    async (args: Record<string, any>) => {
      const path = str(args.path).replace(/^\/+/, '');
      const result = await ghRawText(
        auth,
        githubScopeFor('github_read_file'),
        `${repoPath(str(args.owner), str(args.repo))}/contents/${refSegment(path)}?ref=${encodeURIComponent(str(args.ref))}`,
        RAW_ACCEPT
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
    'github_read_files',
    {
      title: 'GitHub · Read — Read multiple files',
      description:
        'The content of several files at once, at the same branch/tag/commit — fetched ' +
        'concurrently server-side in a single round trip. This is the fast path for reviewing ' +
        'a codebase: list a subtree with github_browse_source (maxDepth > 1), then pull the ' +
        'files it names in batches here instead of one github_read_file call per file. A file ' +
        'that fails to read is reported inline rather than failing the whole batch.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        ref: z.string().min(1).describe('Branch, tag, or commit SHA'),
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(30)
          .describe('File paths within the repository, up to 30 per call'),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const ref = str(args.ref);
      const paths = Array.isArray(args.paths)
        ? [...new Set(args.paths.map((entry: unknown) => str(entry)).filter(Boolean))]
        : [];
      if (paths.length === 0) return errText('No paths given.');
      const scopes = githubScopeFor('github_read_files');
      const base = repoPath(owner, repo);
      const PER_FILE_CAP = 20_000;
      const TOTAL_CAP = 180_000;
      const fetched = await Promise.all(
        paths.map(async (rawPath) => {
          const path = rawPath.replace(/^\/+/, '');
          const result = await ghRawText(
            auth,
            scopes,
            `${base}/contents/${refSegment(path)}?ref=${encodeURIComponent(ref)}`,
            RAW_ACCEPT
          );
          return result.ok
            ? { path: rawPath, ok: true as const, text: result.text }
            : { path: rawPath, ok: false as const, error: result.error };
        })
      );
      let used = 0;
      const sections = fetched.map((entry) => {
        if (!entry.ok) return `=== ${entry.path} ===\nERROR: ${entry.error}`;
        if (used >= TOTAL_CAP) {
          return `=== ${entry.path} ===\n… (skipped — combined response cap reached; fetch this file on its own with github_read_file)`;
        }
        let text = entry.text;
        if (text.length > PER_FILE_CAP) {
          text = `${text.slice(0, PER_FILE_CAP)}\n… (file truncated at ${PER_FILE_CAP.toLocaleString()} characters)`;
        }
        if (used + text.length > TOTAL_CAP) {
          text = `${text.slice(0, Math.max(0, TOTAL_CAP - used))}\n… (truncated — combined response cap reached)`;
        }
        used += text.length;
        return `=== ${entry.path} ===\n${text || '(empty file)'}`;
      });
      return textResult(sections.join('\n\n'));
    }
  );

  server.registerTool(
    'github_search_code',
    {
      title: 'GitHub · Read — Search code',
      description:
        'Full-text code search, scoped to one repository or every repository the App’s ' +
        'installation on `owner` was granted. Supports GitHub’s own search qualifiers, e.g. ' +
        '`extension:ts fetchUser`.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: z.string().describe('Narrow to one repository within owner').optional(),
        query: z.string().min(1).describe('Search terms and qualifiers'),
        max: z.number().int().min(1).max(50).describe('How many matches per page (default 10)').optional(),
        page: z.number().int().min(1).describe('Page of results, 1-based (default 1)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 10;
      const page = typeof args.page === 'number' ? args.page : 1;
      const scope = str(args.repo) ? `repo:${str(args.owner)}/${str(args.repo)}` : `org:${str(args.owner)}`;
      const result = await ghJson(
        auth,
        githubScopeFor('github_search_code'),
        `/search/code?q=${encodeURIComponent(`${str(args.query)} ${scope}`)}&per_page=${max}&page=${page}`
      );
      if (!result.ok) return errText(result.error);
      const body = rec(result.body);
      const items = arr(body.items);
      const lines = items.map((item) => `${str(rec(item.repository).full_name)} — ${str(item.path)}`);
      if (lines.length === 0) return textResult('No matches.');
      const seen = page * max;
      const total = Number(body.total_count) || 0;
      const remaining = total - seen;
      return textResult(
        lines.join('\n') +
          (remaining > 0 ? `\n\n${remaining} more match(es) across further pages — raise page or narrow the query.` : '')
      );
    }
  );

  // ——— Writes ————————————————————————————————————————————————————————

  server.registerTool(
    'github_create_branch',
    {
      title: 'GitHub · Act — Create a branch',
      description: 'Create a branch at a commit (usually another branch’s head).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        name: z.string().min(1).describe('New branch name'),
        target: z.string().min(1).describe('Commit SHA or branch name the new branch starts from'),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const name = str(args.name);
      const scopes = githubScopeFor('github_create_branch');
      const target = str(args.target);
      let sha = target;
      // A branch name (not already a SHA) needs resolving to its head commit.
      if (!/^[0-9a-f]{7,40}$/i.test(target)) {
        const resolved = await ghJson(auth, scopes, `${repoPath(owner, repo)}/git/ref/heads/${refSegment(target)}`);
        if (!resolved.ok) return errText(resolved.error);
        sha = str(rec(rec(resolved.body).object).sha);
        if (!sha) return errText(`Could not resolve "${target}" to a commit.`);
      }
      const result = await ghJson(auth, scopes, `${repoPath(owner, repo)}/git/refs`, {
        method: 'POST',
        json: { ref: `refs/heads/${name}`, sha },
      });
      if (!result.ok) return errText(result.error);
      const url = `${repoUrl(owner, repo)}/tree/${encodeURIComponent(name)}`;
      return {
        content: [
          { type: 'text' as const, text: `Created branch ${name} at ${sha.slice(0, 12)}\n\n[Open on GitHub](${url})` },
        ],
        _meta: actMeta({ id: name, url }),
      };
    }
  );

  server.registerTool(
    'github_delete_branch',
    {
      title: 'GitHub · Act — Delete a branch',
      description:
        'Delete a branch. The commits stay reachable from anything else that references them, ' +
        'but the branch pointer is gone — there is no undo.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ owner: ownerArg, repo: repoArg, name: z.string().min(1).describe('Branch name to delete') }),
    },
    async (args: Record<string, any>) => {
      const name = str(args.name);
      const response = await auth.fetch(
        githubScopeFor('github_delete_branch'),
        `${repoPath(str(args.owner), str(args.repo))}/git/refs/heads/${refSegment(name)}`,
        { method: 'DELETE' }
      );
      if (!response.ok) return errText(await describeGitHubFailure(response));
      return {
        content: [{ type: 'text' as const, text: `Deleted branch ${name}.` }],
        _meta: actMeta({ id: name }),
      };
    }
  );

  server.registerTool(
    'github_commit_file',
    {
      title: 'GitHub · Act — Commit a file change',
      description:
        'Write one file and commit it to a branch in a single step — create or overwrite. For ' +
        'anything beyond a single text file, work through a clone instead, or use ' +
        'github_commit_files.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        branch: z.string().min(1).describe('Branch to commit on (must exist)'),
        path: z.string().min(1).describe('File path within the repository'),
        content: z.string().describe('The full new file content'),
        message: z.string().min(1).describe('Commit message'),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const branch = str(args.branch);
      const path = str(args.path).replace(/^\/+/, '');
      const scopes = githubScopeFor('github_commit_file');
      const contentsPath = `${repoPath(owner, repo)}/contents/${refSegment(path)}`;
      // An overwrite needs the existing blob's sha; a 404 just means this is
      // a new file.
      const existing = await ghJson(auth, scopes, `${contentsPath}?ref=${encodeURIComponent(branch)}`);
      const sha = existing.ok ? str(rec(existing.body).sha) : '';
      const result = await ghJson(auth, scopes, contentsPath, {
        method: 'PUT',
        json: {
          message: str(args.message),
          content: Buffer.from(str(args.content), 'utf8').toString('base64'),
          branch,
          ...(sha ? { sha } : {}),
        },
      });
      if (!result.ok) return errText(result.error);
      const url = `${repoUrl(owner, repo)}/blob/${encodeURIComponent(branch)}/${path}`;
      return {
        content: [{ type: 'text' as const, text: `Committed ${path} to ${branch}.\n\n[Open on GitHub](${url})` }],
        _meta: actMeta({ id: path, url }),
      };
    }
  );

  server.registerTool(
    'github_commit_files',
    {
      title: 'GitHub · Act — Commit multiple file changes',
      description:
        'Write several files — add, overwrite, and/or delete — as a single commit on a branch. ' +
        'The batch counterpart to github_commit_file: use this instead of one commit per file ' +
        'when applying a multi-file change, so the branch never sits in a half-updated state ' +
        'between pushes. For anything beyond a handful of text files, work through a clone instead.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        branch: z.string().min(1).describe('Branch to commit on (must exist)'),
        files: z
          .array(
            z.object({
              path: z.string().min(1).describe('File path within the repository'),
              content: z.string().describe('The full new file content'),
            })
          )
          .max(50)
          .describe('Files to create or overwrite')
          .optional(),
        delete: z.array(z.string().min(1)).max(50).describe('File paths to delete').optional(),
        message: z.string().min(1).describe('Commit message'),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const branch = str(args.branch);
      const scopes = githubScopeFor('github_commit_files');
      const base = repoPath(owner, repo);
      const files: { path: string; content: string }[] = Array.isArray(args.files)
        ? args.files
            .map((entry: unknown) => ({
              path: str(rec(entry).path).replace(/^\/+/, ''),
              content: str(rec(entry).content),
            }))
            .filter((entry: { path: string }) => entry.path.length > 0)
        : [];
      const deletions: string[] = Array.isArray(args.delete)
        ? args.delete.map((entry: unknown) => str(entry).replace(/^\/+/, '')).filter(Boolean)
        : [];
      if (files.length === 0 && deletions.length === 0) {
        return errText('Nothing to commit — pass files to write and/or delete.');
      }

      // The Git Data API's low-level shape: the current commit and tree,
      // one blob per new file, one new tree describing every change
      // (writes AND deletions, the latter via sha:null on that path), a
      // new commit over it, then the branch ref moved to point at it.
      const branchRef = await ghJson(auth, scopes, `${base}/git/ref/heads/${refSegment(branch)}`);
      if (!branchRef.ok) return errText(branchRef.error);
      const baseCommitSha = str(rec(rec(branchRef.body).object).sha);
      if (!baseCommitSha) return errText(`Could not resolve branch "${branch}".`);
      const baseCommit = await ghJson(auth, scopes, `${base}/git/commits/${baseCommitSha}`);
      if (!baseCommit.ok) return errText(baseCommit.error);
      const baseTreeSha = str(rec(rec(baseCommit.body).tree).sha);

      const blobs = await Promise.all(
        files.map(async (file) => {
          const blob = await ghJson(auth, scopes, `${base}/git/blobs`, {
            method: 'POST',
            json: { content: file.content, encoding: 'utf-8' },
          });
          return { path: file.path, blob };
        })
      );
      const failedBlob = blobs.find((entry) => !entry.blob.ok);
      if (failedBlob && !failedBlob.blob.ok) return errText(failedBlob.blob.error);

      const treeEntries = [
        ...blobs.map((entry) => ({
          path: entry.path,
          mode: '100644',
          type: 'blob',
          sha: entry.blob.ok ? str(rec(entry.blob.body).sha) : '',
        })),
        ...deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
      ];
      const newTree = await ghJson(auth, scopes, `${base}/git/trees`, {
        method: 'POST',
        json: { base_tree: baseTreeSha, tree: treeEntries },
      });
      if (!newTree.ok) return errText(newTree.error);

      const newCommit = await ghJson(auth, scopes, `${base}/git/commits`, {
        method: 'POST',
        json: {
          message: str(args.message),
          tree: str(rec(newTree.body).sha),
          parents: [baseCommitSha],
        },
      });
      if (!newCommit.ok) return errText(newCommit.error);
      const newCommitSha = str(rec(newCommit.body).sha);

      const moved = await ghJson(auth, scopes, `${base}/git/refs/heads/${refSegment(branch)}`, {
        method: 'PATCH',
        json: { sha: newCommitSha },
      });
      if (!moved.ok) return errText(moved.error);

      const url = `${repoUrl(owner, repo)}/tree/${encodeURIComponent(branch)}`;
      const summary = [
        files.length > 0 ? `wrote ${files.length} file(s)` : '',
        deletions.length > 0 ? `deleted ${deletions.length} file(s)` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return {
        content: [
          { type: 'text' as const, text: `Committed to ${branch}: ${summary}.\n\n[Open on GitHub](${url})` },
        ],
        _meta: actMeta({ id: branch, url }),
      };
    }
  );
}

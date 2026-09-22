/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pull requests. Reads, the act lifecycle (create, update, approve,
 * request changes, merge, close), and comments, plus preview cards for
 * the two acts worth a human's click before they happen: creating a PR
 * and merging one.
 *
 * Two things Bitbucket has that GitHub's REST API does not, so they are
 * left out rather than faked: withdrawing your own review (GitHub has no
 * "un-approve" endpoint — approve_pull_request's `revoke` therefore
 * refuses with an explanation instead of silently no-op'ing), and
 * resolving a review-comment THREAD (a GraphQL-only mutation —
 * github_resolve_pr_comment uses the GraphQL endpoint for exactly this
 * one call, the one place this module leaves REST).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { actMeta } from '@renkei/tool-outcomes';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import {
  APP_ONLY_META,
  ISSUE_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import type { GitHubAuth } from './github-auth';
import {
  arr,
  errText,
  ghJson,
  ghRawText,
  moreLine,
  num,
  prUrl,
  rec,
  str,
  textResult,
} from './client';
import { githubScopeFor } from './scopes';

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

const ownerArg = z.string().min(1).describe('Account (organization or user) login, from github_list_accounts');
const repoArg = z.string().min(1).describe('Repository name, from github_list_repositories');
const prNumberArg = z.number().int().min(1).describe('Pull request number, e.g. 42');

function prLine(pr: Record<string, unknown>): string {
  return (
    `#${num(pr.number)} ${str(pr.title)} [${str(pr.state)}${pr.draft === true ? ', draft' : ''}]` +
    ` — ${str(rec(pr.head).ref)} → ${str(rec(pr.base).ref)}` +
    ` — by ${str(rec(pr.user).login)}` +
    (str(pr.updated_at) ? ` — updated ${str(pr.updated_at)}` : '')
  );
}

const createPrSchema = z.object({
  owner: ownerArg,
  repo: repoArg,
  title: z.string().min(1).describe('Pull request title'),
  description: z.string().describe('Pull request description, markdown').optional(),
  sourceBranch: z.string().min(1).describe('Branch with the changes (head)'),
  destinationBranch: z
    .string()
    .describe('Branch to merge into (base); default the repository’s default branch')
    .optional(),
  draft: z.boolean().describe('Open as a draft pull request').optional(),
  reviewers: z
    .array(z.string())
    .describe('Reviewer logins to request')
    .optional(),
});

export async function registerPullRequestTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GitHubAuth
): Promise<void> {
  server.registerTool(
    'github_list_pull_requests',
    {
      title: 'GitHub · Read — List pull requests',
      description: 'List a repository’s pull requests, most recently updated first. Default state open.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        state: z.enum(['open', 'closed', 'all']).describe('Default open').optional(),
        max: z.number().int().min(1).max(50).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 20;
      const state = str(args.state) || 'open';
      const result = await ghJson(
        auth,
        githubScopeFor('github_list_pull_requests'),
        `${repoPath(str(args.owner), str(args.repo))}/pulls?state=${state}&sort=updated&direction=desc&per_page=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = arr(result.body).map(prLine);
      if (lines.length === 0) return textResult('No pull requests.');
      return textResult(
        withPresentationHint(
          lines.join('\n') + moreLine(result.hasMore, 'raise max to see more.'),
          'a table (PR, Title, State, Source → Destination, Author, Updated) usually scans ' +
            'faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'github_get_pull_request',
    {
      title: 'GitHub · Read — Get a pull request',
      description: 'One pull request in full: description, reviews, combined check status, and per-file change stats.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ owner: ownerArg, repo: repoArg, number: prNumberArg }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const number = Number(args.number);
      const base = `${repoPath(owner, repo)}/pulls/${number}`;
      const scopes = githubScopeFor('github_get_pull_request');
      const [prResult, reviewsResult] = await Promise.all([
        ghJson(auth, scopes, base),
        ghJson(auth, scopes, `${base}/reviews?per_page=50`),
      ]);
      if (!prResult.ok) return errText(prResult.error);
      const pr = rec(prResult.body);
      const reviews = reviewsResult.ok
        ? arr(reviewsResult.body).map(
            (review) => `  ${str(rec(review.user).login)} — ${str(review.state)}`
          )
        : [];
      const lines = [
        `#${num(pr.number)} ${str(pr.title)} [${str(pr.state)}${pr.draft === true ? ', draft' : ''}]`,
        `${str(rec(pr.head).ref)} → ${str(rec(pr.base).ref)}`,
        `Author: ${str(rec(pr.user).login)}`,
        `Updated: ${str(pr.updated_at)}`,
        ...(reviews.length > 0 ? ['Reviews:', ...reviews] : []),
        '',
        str(pr.body).trim() || '(no description)',
      ];
      // Combined check/status state for the head commit — additive context;
      // its failure costs the status line, not the pull request.
      const headSha = str(rec(pr.head).sha);
      if (headSha) {
        const status = await ghJson(auth, scopes, `${repoPath(owner, repo)}/commits/${headSha}/status`);
        if (status.ok) {
          const body = rec(status.body);
          if (str(body.state)) lines.push('', `Checks: ${str(body.state)}`);
        }
      }
      lines.push(
        '',
        `Changes: ${num(pr.changed_files) || '?'} file(s), +${num(pr.additions) || '0'}/-${num(pr.deletions) || '0'}`
      );
      lines.push('', `[Open on GitHub](${prUrl(owner, repo, number)})`);
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'github_get_pull_request_diff',
    {
      title: 'GitHub · Read — Get a pull request’s diff',
      description:
        'The unified diff of a pull request. Large diffs are truncated — the per-file stats on ' +
        'github_get_pull_request scale better for a survey.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ owner: ownerArg, repo: repoArg, number: prNumberArg }),
    },
    async (args: Record<string, any>) => {
      const result = await ghRawText(
        auth,
        githubScopeFor('github_get_pull_request_diff'),
        `${repoPath(str(args.owner), str(args.repo))}/pulls/${Number(args.number)}`,
        'application/vnd.github.v3.diff'
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
    'github_list_pr_comments',
    {
      title: 'GitHub · Read — List pull request comments',
      description:
        'A pull request’s comments, oldest first — both the general conversation and inline ' +
        'review comments (which carry their file and line).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        number: prNumberArg,
        max: z.number().int().min(1).max(100).describe('How many of each kind (default 50)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 50;
      const base = repoPath(str(args.owner), str(args.repo));
      const number = Number(args.number);
      const scopes = githubScopeFor('github_list_pr_comments');
      const [issueComments, reviewComments] = await Promise.all([
        ghJson(auth, scopes, `${base}/issues/${number}/comments?per_page=${max}`),
        ghJson(auth, scopes, `${base}/pulls/${number}/comments?per_page=${max}`),
      ]);
      if (!issueComments.ok) return errText(issueComments.error);
      const general = arr(issueComments.body).map(
        (comment) =>
          `[${str(comment.created_at)}] ${str(rec(comment.user).login)} (comment ${num(comment.id)}):\n  ${str(comment.body).replace(/\n/g, '\n  ')}`
      );
      const inline = reviewComments.ok
        ? arr(reviewComments.body).map(
            (comment) =>
              `[${str(comment.created_at)}] ${str(rec(comment.user).login)} (comment ${num(comment.id)})` +
              ` — on ${str(comment.path)}${num(comment.line) ? `:${num(comment.line)}` : ''}:\n` +
              `  ${str(comment.body).replace(/\n/g, '\n  ')}`
          )
        : [];
      const lines = [...general, ...inline];
      if (lines.length === 0) return textResult('No comments.');
      return textResult(lines.join('\n\n'));
    }
  );

  // ——— Create (with preview) ————————————————————————————————————————

  const createHandler = async (args: Record<string, any>) => {
    const owner = str(args.owner);
    const repo = str(args.repo);
    if (!owner || !repo || !str(args.title) || !str(args.sourceBranch)) {
      return errText('owner, repo, title, and sourceBranch are required');
    }
    const scopes = githubScopeFor('github_create_pull_request');
    const result = await ghJson(auth, scopes, `${repoPath(owner, repo)}/pulls`, {
      method: 'POST',
      json: {
        title: str(args.title),
        ...(str(args.description) ? { body: str(args.description) } : {}),
        head: str(args.sourceBranch),
        base: str(args.destinationBranch) || undefined,
        draft: args.draft === true,
      },
    });
    if (!result.ok) return errText(result.error);
    const pr = rec(result.body);
    const number = num(pr.number);
    const url = prUrl(owner, repo, number);
    const reviewers = Array.isArray(args.reviewers)
      ? args.reviewers.map((r: unknown) => str(r)).filter(Boolean)
      : [];
    if (reviewers.length > 0) {
      // Additive: the PR exists either way, so a reviewer-request failure is
      // reported inline rather than failing the whole create.
      const requested = await ghJson(auth, scopes, `${repoPath(owner, repo)}/pulls/${number}/requested_reviewers`, {
        method: 'POST',
        json: { reviewers },
      });
      if (!requested.ok) {
        return textResult(
          `Created pull request #${number}: ${str(pr.title)}\n` +
            `${str(rec(pr.head).ref)} → ${str(rec(pr.base).ref)}\n` +
            `Reviewers could not be requested: ${requested.error}\n\n[Open on GitHub](${url})`
        );
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Created pull request #${number}: ${str(pr.title)}\n` +
            `${str(rec(pr.head).ref)} → ${str(rec(pr.base).ref)}` +
            (reviewers.length > 0 ? `\nReviewers: ${reviewers.length} requested` : '') +
            `\n\n[Open on GitHub](${url})`,
        },
      ],
      _meta: actMeta({ id: `#${number}`, url }),
    };
  };

  server.registerTool(
    'github_create_pull_request',
    {
      title: 'GitHub · Act — Create a pull request',
      description:
        'Open a pull request from one branch into another. Prefer ' +
        'github_create_pull_request_preview whenever the user should review it first.',
      annotations: { readOnlyHint: false },
      inputSchema: createPrSchema,
    },
    createHandler
  );

  server.registerTool(
    'github_create_pull_request_preview',
    {
      title: 'GitHub · Act — Preview a pull request before opening it',
      description:
        'Show the user an interactive preview card of a pull request to open or cancel. ' +
        'Prefer this over github_create_pull_request whenever the user should review first — ' +
        'the card does the creating.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: createPrSchema,
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      if (!owner || !repo || !str(args.title) || !str(args.sourceBranch)) {
        return errText('owner, repo, title, and sourceBranch are required');
      }
      let destination = str(args.destinationBranch);
      if (!destination) {
        const repository = await ghJson(auth, githubScopeFor('github_get_repository'), repoPath(owner, repo));
        if (repository.ok) destination = str(rec(repository.body).default_branch);
      }
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `The pull request "${str(args.title)}" is awaiting the user's decision on the ` +
              `preview card. Do not create it another way and do not repeat its contents in ` +
              `your reply; the user confirms or cancels from the card. If no card appeared ` +
              `in this client, ask the user how to proceed.`,
          },
        ],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: 'Open pull request',
          subtitle: `${owner}/${repo}`,
          confirmTool: 'github_create_pull_request_confirm',
          confirmLabel: 'Open pull request',
          confirmArgs: args,
          editable: { summaryKey: 'title', descriptionKey: 'description' },
          fields: [
            { label: 'Source', value: str(args.sourceBranch) },
            { label: 'Destination', value: destination || '(repository default branch)' },
            ...(Array.isArray(args.reviewers) && args.reviewers.length > 0
              ? [{ label: 'Reviewers', value: `${args.reviewers.length} selected` }]
              : []),
            ...(args.draft === true ? [{ label: 'Draft', value: 'yes' }] : []),
          ],
        },
      };
    }
  );

  server.registerTool(
    'github_create_pull_request_confirm',
    {
      title: 'GitHub · Act — Open a previewed pull request (card only)',
      description:
        'Open a pull request the user approved on a preview card.' +
        confirmGuard('github_create_pull_request_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: createPrSchema,
    },
    createHandler
  );

  server.registerTool(
    'github_update_pull_request',
    {
      title: 'GitHub · Act — Update a pull request',
      description:
        'Change a pull request’s title, description, or destination branch. Only the fields ' +
        'passed change.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        number: prNumberArg,
        title: z.string().describe('New title').optional(),
        description: z.string().describe('New description, markdown').optional(),
        destinationBranch: z.string().describe('New destination (base) branch').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const number = Number(args.number);
      const body: Record<string, unknown> = {};
      if (str(args.title)) body.title = str(args.title);
      if (args.description !== undefined) body.body = str(args.description);
      if (str(args.destinationBranch)) body.base = str(args.destinationBranch);
      if (Object.keys(body).length === 0) return errText('Nothing to update.');
      const result = await ghJson(
        auth,
        githubScopeFor('github_update_pull_request'),
        `${repoPath(owner, repo)}/pulls/${number}`,
        { method: 'PATCH', json: body }
      );
      if (!result.ok) return errText(result.error);
      const url = prUrl(owner, repo, number);
      return {
        content: [{ type: 'text' as const, text: `Updated pull request #${number}.\n\n[Open on GitHub](${url})` }],
        _meta: actMeta({ id: `#${number}`, url }),
      };
    }
  );

  server.registerTool(
    'github_approve_pull_request',
    {
      title: 'GitHub · Act — Approve a pull request',
      description:
        'Approve a pull request as the connected user. GitHub has no API to withdraw your own ' +
        'review once submitted, so there is no revoke here — submit a new review instead ' +
        '(github_request_pr_changes, or a comment).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        number: prNumberArg,
        comment: z.string().describe('Optional review comment').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const number = Number(args.number);
      const result = await ghJson(
        auth,
        githubScopeFor('github_approve_pull_request'),
        `${repoPath(owner, repo)}/pulls/${number}/reviews`,
        { method: 'POST', json: { event: 'APPROVE', ...(str(args.comment) ? { body: str(args.comment) } : {}) } }
      );
      if (!result.ok) return errText(result.error);
      return {
        content: [{ type: 'text' as const, text: `Approved #${number}.` }],
        _meta: actMeta({ id: `#${number}`, url: prUrl(owner, repo, number) }),
      };
    }
  );

  server.registerTool(
    'github_request_pr_changes',
    {
      title: 'GitHub · Act — Request changes on a pull request',
      description: 'Submit a "request changes" review — the reviewer’s red flag. Say WHAT needs changing in `comment`.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        number: prNumberArg,
        comment: z.string().min(1).describe('What needs to change'),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const number = Number(args.number);
      const result = await ghJson(
        auth,
        githubScopeFor('github_request_pr_changes'),
        `${repoPath(owner, repo)}/pulls/${number}/reviews`,
        { method: 'POST', json: { event: 'REQUEST_CHANGES', body: str(args.comment) } }
      );
      if (!result.ok) return errText(result.error);
      return {
        content: [{ type: 'text' as const, text: `Changes requested on #${number}.` }],
        _meta: actMeta({ id: `#${number}`, url: prUrl(owner, repo, number) }),
      };
    }
  );

  // ——— Merge (with preview) ————————————————————————————————————————

  const mergeSchema = z.object({
    owner: ownerArg,
    repo: repoArg,
    number: prNumberArg,
    strategy: z.enum(['merge', 'squash', 'rebase']).describe('Merge method; default the repository’s configured one').optional(),
    message: z.string().describe('Commit message; default GitHub’s').optional(),
  });

  const mergeHandler = async (args: Record<string, any>) => {
    const owner = str(args.owner);
    const repo = str(args.repo);
    const number = Number(args.number);
    const result = await ghJson(
      auth,
      githubScopeFor('github_merge_pull_request'),
      `${repoPath(owner, repo)}/pulls/${number}/merge`,
      {
        method: 'PUT',
        json: {
          ...(str(args.strategy) ? { merge_method: str(args.strategy) } : {}),
          ...(str(args.message) ? { commit_message: str(args.message) } : {}),
        },
      }
    );
    if (!result.ok) return errText(result.error);
    const url = prUrl(owner, repo, number);
    return {
      content: [{ type: 'text' as const, text: `Merged pull request #${number}.\n\n[Open on GitHub](${url})` }],
      _meta: actMeta({ id: `#${number}`, url }),
    };
  };

  server.registerTool(
    'github_merge_pull_request',
    {
      title: 'GitHub · Act — Merge a pull request',
      description:
        'Merge a pull request into its destination branch. Prefer ' +
        'github_merge_pull_request_preview whenever the user should confirm first — a merge is ' +
        'not undoable from here.',
      annotations: { readOnlyHint: false },
      inputSchema: mergeSchema,
    },
    mergeHandler
  );

  server.registerTool(
    'github_merge_pull_request_preview',
    {
      title: 'GitHub · Act — Preview a merge before performing it',
      description:
        'Show the user an interactive card confirming a pull request merge. Prefer this over ' +
        'github_merge_pull_request whenever the user should confirm — the card does the merging.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: mergeSchema,
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const number = Number(args.number);
      let subtitle = `${owner}/${repo}`;
      const fields: { label: string; value: string }[] = [];
      const prResult = await ghJson(auth, githubScopeFor('github_get_pull_request'), `${repoPath(owner, repo)}/pulls/${number}`);
      if (prResult.ok) {
        const pr = rec(prResult.body);
        subtitle = `#${number} ${str(pr.title)}`;
        fields.push({ label: 'Branches', value: `${str(rec(pr.head).ref)} → ${str(rec(pr.base).ref)}` });
      }
      fields.push({ label: 'Method', value: str(args.strategy) || 'repository default' });
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `The merge of pull request #${number} is awaiting the user's decision on the ` +
              `preview card. Do not merge it another way; the user confirms or cancels from ` +
              `the card. If no card appeared in this client, ask the user how to proceed.`,
          },
        ],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: 'Merge pull request',
          subtitle,
          confirmTool: 'github_merge_pull_request_confirm',
          confirmLabel: 'Merge',
          confirmArgs: args,
          fields,
        },
      };
    }
  );

  server.registerTool(
    'github_merge_pull_request_confirm',
    {
      title: 'GitHub · Act — Merge a previewed pull request (card only)',
      description:
        'Merge a pull request the user approved on a preview card.' +
        confirmGuard('github_merge_pull_request_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: mergeSchema,
    },
    mergeHandler
  );

  server.registerTool(
    'github_close_pull_request',
    {
      title: 'GitHub · Act — Close a pull request',
      description: 'Close a pull request without merging. It can be reopened from the GitHub UI.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ owner: ownerArg, repo: repoArg, number: prNumberArg }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const number = Number(args.number);
      const result = await ghJson(
        auth,
        githubScopeFor('github_close_pull_request'),
        `${repoPath(owner, repo)}/pulls/${number}`,
        { method: 'PATCH', json: { state: 'closed' } }
      );
      if (!result.ok) return errText(result.error);
      return {
        content: [{ type: 'text' as const, text: `Closed pull request #${number}.` }],
        _meta: actMeta({ id: `#${number}`, url: prUrl(owner, repo, number) }),
      };
    }
  );

  server.registerTool(
    'github_add_pr_comment',
    {
      title: 'GitHub · Act — Comment on a pull request',
      description:
        'Add a comment to a pull request — on the whole PR, or inline on a file line (path + ' +
        'line; commitSha required for an inline comment).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        number: prNumberArg,
        comment: z.string().min(1).describe('Comment text, markdown'),
        path: z.string().describe('File path, for an inline comment').optional(),
        line: z.number().int().min(1).describe('Line in the new version of that file, for an inline comment').optional(),
        commitSha: z.string().describe('The commit an inline comment anchors to — the PR’s head SHA').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const number = Number(args.number);
      const path = str(args.path);
      if (path) {
        let commitSha = str(args.commitSha);
        if (!commitSha) {
          const pr = await ghJson(auth, githubScopeFor('github_get_pull_request'), `${repoPath(owner, repo)}/pulls/${number}`);
          if (!pr.ok) return errText(pr.error);
          commitSha = str(rec(rec(pr.body).head).sha);
        }
        const result = await ghJson(
          auth,
          githubScopeFor('github_add_pr_comment'),
          `${repoPath(owner, repo)}/pulls/${number}/comments`,
          {
            method: 'POST',
            json: { body: str(args.comment), path, commit_id: commitSha, line: Number(args.line), side: 'RIGHT' },
          }
        );
        if (!result.ok) return errText(result.error);
        return {
          content: [{ type: 'text' as const, text: `Inline comment added to #${number} (comment ${num(rec(result.body).id)}).` }],
          _meta: actMeta({ id: `#${number}`, url: prUrl(owner, repo, number) }),
        };
      }
      const result = await ghJson(
        auth,
        githubScopeFor('github_add_pr_comment'),
        `${repoPath(owner, repo)}/issues/${number}/comments`,
        { method: 'POST', json: { body: str(args.comment) } }
      );
      if (!result.ok) return errText(result.error);
      return {
        content: [{ type: 'text' as const, text: `Comment added to #${number} (comment ${num(rec(result.body).id)}).` }],
        _meta: actMeta({ id: `#${number}`, url: prUrl(owner, repo, number) }),
      };
    }
  );

  server.registerTool(
    'github_resolve_pr_comment',
    {
      title: 'GitHub · Act — Resolve a pull request review thread',
      description:
        'Mark an inline review comment’s thread resolved — or reopen it with reopen:true. ' +
        'REST has no endpoint for this; it goes through GitHub’s GraphQL API, looking up the ' +
        'thread that contains the given comment first.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        number: prNumberArg,
        commentId: z.number().int().min(1).describe('From github_list_pr_comments (an inline review comment)'),
        reopen: z.boolean().describe('Reopen instead of resolving').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const number = Number(args.number);
      const commentId = Number(args.commentId);
      const scopes = githubScopeFor('github_resolve_pr_comment');
      // Find the review thread node id that contains this comment.
      const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId}}}}}}}`;
      const looked = await ghJson(auth, scopes, '/graphql', {
        method: 'POST',
        json: { query, variables: { owner, repo, number } },
      });
      if (!looked.ok) return errText(looked.error);
      const threads = arr(rec(rec(rec(rec(rec(looked.body).data).repository).pullRequest).reviewThreads).nodes);
      const thread = threads.find((candidate) =>
        arr(rec(candidate.comments).nodes).some((comment) => Number(comment.databaseId) === commentId)
      );
      if (!thread) {
        return errText(`Comment ${commentId} was not found on an open review thread of #${number}.`);
      }
      const reopen = args.reopen === true;
      const mutation = reopen
        ? 'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}'
        : 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}';
      const applied = await ghJson(auth, scopes, '/graphql', {
        method: 'POST',
        json: { query: mutation, variables: { id: thread.id } },
      });
      if (!applied.ok) return errText(applied.error);
      return textResult(
        reopen ? `Thread reopened on #${number}.` : `Thread resolved on #${number}.`
      );
    }
  );
}

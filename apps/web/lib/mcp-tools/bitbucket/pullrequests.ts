/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pull requests — the reason most people connect Bitbucket at all. Reads,
 * the full act lifecycle (create, update, approve, request changes, merge,
 * decline), comments and tasks, plus preview cards for the two acts worth
 * a human's click before they happen: creating a PR and merging one.
 *
 * PR bodies and comments are plain markdown on this API — no conversion.
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
import type { BitbucketAuth } from './bitbucket-auth';
import {
  bbJson,
  bbRawText,
  describeBitbucketFailure,
  errText,
  moreLine,
  num,
  prUrl,
  rec,
  str,
  textResult,
  values,
} from './client';
import { bitbucketScopeFor } from './scopes';

function repoPath(workspace: string, repoSlug: string): string {
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

const workspaceArg = z.string().min(1).describe('Workspace slug, from bitbucket_list_workspaces');
const repoArg = z.string().min(1).describe('Repository slug, from bitbucket_list_repositories');
const prIdArg = z.number().int().min(1).describe('Pull request id, e.g. 42');

function prLine(pr: Record<string, unknown>): string {
  const source = str(rec(rec(pr.source).branch).name);
  const destination = str(rec(rec(pr.destination).branch).name);
  return (
    `#${num(pr.id)} ${str(pr.title)} [${str(pr.state)}]` +
    ` — ${source} → ${destination}` +
    ` — by ${str(rec(pr.author).display_name)}` +
    (num(pr.comment_count) !== '' ? ` — ${num(pr.comment_count)} comment(s)` : '') +
    (str(pr.updated_on) ? ` — updated ${str(pr.updated_on)}` : '')
  );
}

/** The create/update wire body from the shared tool arguments. */
function prBody(args: Record<string, any>): Record<string, unknown> {
  return {
    title: str(args.title),
    ...(str(args.description) ? { description: str(args.description) } : {}),
    source: { branch: { name: str(args.sourceBranch) } },
    ...(str(args.destinationBranch)
      ? { destination: { branch: { name: str(args.destinationBranch) } } }
      : {}),
    ...(typeof args.closeSourceBranch === 'boolean'
      ? { close_source_branch: args.closeSourceBranch }
      : {}),
    ...(Array.isArray(args.reviewers) && args.reviewers.length > 0
      ? {
          reviewers: args.reviewers.map((reviewer: unknown) => ({
            // Reviewers are named by uuid (from bitbucket_list_default_reviewers
            // or workspace member listings); braces tolerated either way.
            uuid: /^\{.*\}$/.test(String(reviewer)) ? String(reviewer) : `{${String(reviewer)}}`,
          })),
        }
      : {}),
  };
}

const createPrSchema = z.object({
  workspace: workspaceArg,
  repoSlug: repoArg,
  title: z.string().min(1).describe('Pull request title'),
  description: z.string().describe('Pull request description, markdown').optional(),
  sourceBranch: z.string().min(1).describe('Branch with the changes'),
  destinationBranch: z
    .string()
    .describe('Branch to merge into; default the repository’s main branch')
    .optional(),
  closeSourceBranch: z
    .boolean()
    .describe('Delete the source branch when the pull request merges')
    .optional(),
  reviewers: z
    .array(z.string())
    .describe(
      'Reviewer account uuids — bitbucket_list_default_reviewers has the usual ones. The API ' +
        'does NOT add default reviewers by itself.'
    )
    .optional(),
});

export async function registerPullRequestTools(
  server: McpServer,
  context: MCPToolContext,
  auth: BitbucketAuth
): Promise<void> {
  server.registerTool(
    'bitbucket_list_pull_requests',
    {
      title: 'Bitbucket · Read — List pull requests',
      description:
        'List a repository’s pull requests, most recently updated first. Default state OPEN; ' +
        'query filters further, e.g. author.nickname = "scott".',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        state: z
          .enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'])
          .describe('Default OPEN')
          .optional(),
        query: z.string().describe('Bitbucket filter expression').optional(),
        max: z.number().int().min(1).max(50).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 20;
      const parts = [`pagelen=${max}`, `state=${str(args.state) || 'OPEN'}`, 'sort=-updated_on'];
      if (str(args.query)) parts.push(`q=${encodeURIComponent(str(args.query))}`);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_pull_requests'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests?${parts.join('&')}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(prLine);
      if (lines.length === 0) return textResult('No pull requests.');
      return textResult(
        withPresentationHint(
          lines.join('\n') + moreLine(result.body, 'narrow with query or raise max.'),
          'a table (PR, Title, State, Source → Destination, Author, Updated) usually scans ' +
            'faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'bitbucket_get_pull_request',
    {
      title: 'Bitbucket · Read — Get a pull request',
      description:
        'One pull request in full: description, reviewers and their approvals, build ' +
        'statuses, and per-file change stats.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ workspace: workspaceArg, repoSlug: repoArg, id: prIdArg }),
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const repoSlug = str(args.repoSlug);
      const id = Number(args.id);
      const base = `${repoPath(workspace, repoSlug)}/pullrequests/${id}`;
      const scopes = bitbucketScopeFor('bitbucket_get_pull_request');
      const [prResult, statusResult, statResult] = await Promise.all([
        bbJson(auth, scopes, base),
        bbJson(auth, scopes, `${base}/statuses?pagelen=20`),
        bbJson(auth, scopes, `${base}/diffstat?pagelen=100`),
      ]);
      if (!prResult.ok) return errText(prResult.error);
      const pr = prResult.body;
      const participants = Array.isArray(pr.participants) ? pr.participants.map(rec) : [];
      const reviewers = participants
        .filter((participant) => str(participant.role) === 'REVIEWER')
        .map(
          (participant) =>
            `  ${str(rec(participant.user).display_name)}` +
            (participant.approved === true
              ? ' — approved'
              : str(participant.state) === 'changes_requested'
                ? ' — requested changes'
                : '')
        );
      const lines = [
        `#${num(pr.id)} ${str(pr.title)} [${str(pr.state)}]`,
        `${str(rec(rec(pr.source).branch).name)} → ${str(rec(rec(pr.destination).branch).name)}`,
        `Author: ${str(rec(pr.author).display_name)}`,
        `Updated: ${str(pr.updated_on)}`,
        ...(reviewers.length > 0 ? ['Reviewers:', ...reviewers] : []),
        '',
        str(pr.description).trim() || '(no description)',
      ];
      if (statusResult.ok) {
        const statuses = values(statusResult.body).map(
          (status) => `  ${str(status.name) || str(status.key)}: ${str(status.state)}`
        );
        if (statuses.length > 0) lines.push('', 'Builds:', ...statuses);
      }
      if (statResult.ok) {
        const stats = values(statResult.body);
        const added = stats.reduce((sum, entry) => sum + (Number(entry.lines_added) || 0), 0);
        const removed = stats.reduce((sum, entry) => sum + (Number(entry.lines_removed) || 0), 0);
        lines.push('', `Changes: ${stats.length} file(s), +${added}/-${removed}`);
      }
      lines.push('', `[Open in Bitbucket](${prUrl(workspace, repoSlug, id)})`);
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'bitbucket_get_pull_request_diff',
    {
      title: 'Bitbucket · Read — Get a pull request’s diff',
      description:
        'The unified diff of a pull request. Large diffs are truncated — the per-file stats on ' +
        'bitbucket_get_pull_request scale better for a survey.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ workspace: workspaceArg, repoSlug: repoArg, id: prIdArg }),
    },
    async (args: Record<string, any>) => {
      const result = await bbRawText(
        auth,
        bitbucketScopeFor('bitbucket_get_pull_request_diff'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests/${Number(args.id)}/diff`
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
    'bitbucket_list_pr_comments',
    {
      title: 'Bitbucket · Read — List pull request comments',
      description:
        'A pull request’s comments, oldest first — inline ones carry their file and line.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        id: prIdArg,
        max: z.number().int().min(1).max(100).describe('How many (default 50)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 50;
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_pr_comments'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests/${Number(args.id)}/comments?pagelen=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body)
        .filter((comment) => comment.deleted !== true)
        .map((comment) => {
          const inline = rec(comment.inline);
          const where = str(inline.path)
            ? ` — on ${str(inline.path)}${num(inline.to) ? `:${num(inline.to)}` : ''}`
            : '';
          const resolved = rec(comment.resolution).type ? ' — RESOLVED' : '';
          return (
            `[${str(comment.created_on)}] ${str(rec(comment.user).display_name)}` +
            ` (comment ${num(comment.id)})${where}${resolved}:\n` +
            `  ${str(rec(comment.content).raw).replace(/\n/g, '\n  ')}`
          );
        });
      if (lines.length === 0) return textResult('No comments.');
      return textResult(lines.join('\n\n') + moreLine(result.body, 'raise max to see more.'));
    }
  );

  server.registerTool(
    'bitbucket_list_default_reviewers',
    {
      title: 'Bitbucket · Read — List a repository’s default reviewers',
      description:
        'Who Bitbucket would suggest reviewing changes in this repository (repository and ' +
        'project defaults combined). Pass their uuids as reviewers when creating a pull ' +
        'request — the API does not add them by itself.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ workspace: workspaceArg, repoSlug: repoArg }),
    },
    async (args: Record<string, any>) => {
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_default_reviewers'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/effective-default-reviewers?pagelen=50`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map((entry) => {
        const user = rec(entry.user);
        return `${str(user.display_name)} — uuid: ${str(user.uuid)}`;
      });
      if (lines.length === 0) return textResult('No default reviewers configured.');
      return textResult(lines.join('\n'));
    }
  );

  // ——— Create (with preview) ————————————————————————————————————————

  const createHandler = async (args: Record<string, any>) => {
    const workspace = str(args.workspace);
    const repoSlug = str(args.repoSlug);
    if (!workspace || !repoSlug || !str(args.title) || !str(args.sourceBranch)) {
      return errText('workspace, repoSlug, title, and sourceBranch are required');
    }
    const result = await bbJson(
      auth,
      bitbucketScopeFor('bitbucket_create_pull_request'),
      `${repoPath(workspace, repoSlug)}/pullrequests`,
      { method: 'POST', json: prBody(args) }
    );
    if (!result.ok) return errText(result.error);
    const id = num(result.body.id);
    const url = prUrl(workspace, repoSlug, id);
    const reviewerCount = Array.isArray(args.reviewers) ? args.reviewers.length : 0;
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Created pull request #${id}: ${str(result.body.title)}\n` +
            `${str(rec(rec(result.body.source).branch).name)} → ` +
            `${str(rec(rec(result.body.destination).branch).name)}` +
            (reviewerCount > 0 ? `\nReviewers: ${reviewerCount} set` : '') +
            `\n\n[Open in Bitbucket](${url})`,
        },
      ],
      _meta: actMeta({ id: `#${id}`, url }),
    };
  };

  server.registerTool(
    'bitbucket_create_pull_request',
    {
      title: 'Bitbucket · Act — Create a pull request',
      description:
        'Open a pull request from one branch into another. Prefer ' +
        'bitbucket_create_pull_request_preview whenever the user should review it first.',
      annotations: { readOnlyHint: false },
      inputSchema: createPrSchema,
    },
    createHandler
  );

  server.registerTool(
    'bitbucket_create_pull_request_preview',
    {
      title: 'Bitbucket · Act — Preview a pull request before opening it',
      description:
        'Show the user an interactive preview card of a pull request to open or cancel. ' +
        'Prefer this over bitbucket_create_pull_request whenever the user should review ' +
        'first — the card does the creating.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: createPrSchema,
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const repoSlug = str(args.repoSlug);
      if (!workspace || !repoSlug || !str(args.title) || !str(args.sourceBranch)) {
        return errText('workspace, repoSlug, title, and sourceBranch are required');
      }
      // Best-effort: name the real destination like the created PR would.
      let destination = str(args.destinationBranch);
      if (!destination) {
        const repo = await bbJson(
          auth,
          bitbucketScopeFor('bitbucket_get_repository'),
          repoPath(workspace, repoSlug)
        );
        if (repo.ok) destination = str(rec(repo.body.mainbranch).name);
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
          subtitle: `${workspace}/${repoSlug}`,
          confirmTool: 'bitbucket_create_pull_request_confirm',
          confirmLabel: 'Open pull request',
          confirmArgs: args,
          editable: { summaryKey: 'title', descriptionKey: 'description' },
          fields: [
            { label: 'Source', value: str(args.sourceBranch) },
            { label: 'Destination', value: destination || '(repository main branch)' },
            ...(Array.isArray(args.reviewers) && args.reviewers.length > 0
              ? [{ label: 'Reviewers', value: `${args.reviewers.length} selected` }]
              : []),
            ...(args.closeSourceBranch === true
              ? [{ label: 'On merge', value: 'delete the source branch' }]
              : []),
          ],
        },
      };
    }
  );

  server.registerTool(
    'bitbucket_create_pull_request_confirm',
    {
      title: 'Bitbucket · Act — Open a previewed pull request (card only)',
      description:
        'Open a pull request the user approved on a preview card.' +
        confirmGuard('bitbucket_create_pull_request_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: createPrSchema,
    },
    createHandler
  );

  server.registerTool(
    'bitbucket_update_pull_request',
    {
      title: 'Bitbucket · Act — Update a pull request',
      description:
        'Change a pull request’s title, description, destination branch, or reviewer list. ' +
        'Only the fields passed change.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        id: prIdArg,
        title: z.string().describe('New title').optional(),
        description: z.string().describe('New description, markdown').optional(),
        destinationBranch: z.string().describe('New destination branch').optional(),
        reviewers: z
          .array(z.string())
          .describe('New reviewer uuid list — REPLACES the existing reviewers')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const repoSlug = str(args.repoSlug);
      const id = Number(args.id);
      // Bitbucket's PUT requires title even for partial edits, so read the
      // current PR first and merge.
      const base = `${repoPath(workspace, repoSlug)}/pullrequests/${id}`;
      const current = await bbJson(auth, bitbucketScopeFor('bitbucket_get_pull_request'), base);
      if (!current.ok) return errText(current.error);
      const body: Record<string, unknown> = {
        title: str(args.title) || str(current.body.title),
        ...(args.description !== undefined
          ? { description: str(args.description) }
          : str(current.body.description)
            ? { description: str(current.body.description) }
            : {}),
        ...(str(args.destinationBranch)
          ? { destination: { branch: { name: str(args.destinationBranch) } } }
          : {}),
        ...(Array.isArray(args.reviewers)
          ? {
              reviewers: args.reviewers.map((reviewer: unknown) => ({
                uuid: /^\{.*\}$/.test(String(reviewer))
                  ? String(reviewer)
                  : `{${String(reviewer)}}`,
              })),
            }
          : {}),
      };
      const result = await bbJson(auth, bitbucketScopeFor('bitbucket_update_pull_request'), base, {
        method: 'PUT',
        json: body,
      });
      if (!result.ok) return errText(result.error);
      const url = prUrl(workspace, repoSlug, id);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated pull request #${id}.\n\n[Open in Bitbucket](${url})`,
          },
        ],
        _meta: actMeta({ id: `#${id}`, url }),
      };
    }
  );

  server.registerTool(
    'bitbucket_approve_pull_request',
    {
      title: 'Bitbucket · Act — Approve a pull request',
      description:
        'Approve a pull request as the connected user — or take an approval back with ' +
        'revoke:true.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        id: prIdArg,
        revoke: z.boolean().describe('Withdraw the approval instead of granting it').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const id = Number(args.id);
      const revoke = args.revoke === true;
      const response = await auth.fetch(
        bitbucketScopeFor('bitbucket_approve_pull_request'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests/${id}/approve`,
        { method: revoke ? 'DELETE' : 'POST' }
      );
      if (!response.ok) return errText(await describeBitbucketFailure(response));
      const url = prUrl(str(args.workspace), str(args.repoSlug), id);
      return {
        content: [
          {
            type: 'text' as const,
            text: revoke ? `Approval withdrawn from #${id}.` : `Approved #${id}.`,
          },
        ],
        _meta: actMeta({ id: `#${id}`, url }),
      };
    }
  );

  server.registerTool(
    'bitbucket_request_pr_changes',
    {
      title: 'Bitbucket · Act — Request changes on a pull request',
      description:
        'Mark a pull request as needing changes (the reviewer’s red flag) — or clear the ' +
        'flag with revoke:true. Say WHAT needs changing with bitbucket_add_pr_comment.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        id: prIdArg,
        revoke: z.boolean().describe('Clear the request-changes flag').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const id = Number(args.id);
      const revoke = args.revoke === true;
      const response = await auth.fetch(
        bitbucketScopeFor('bitbucket_request_pr_changes'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests/${id}/request-changes`,
        { method: revoke ? 'DELETE' : 'POST' }
      );
      if (!response.ok) return errText(await describeBitbucketFailure(response));
      return {
        content: [
          {
            type: 'text' as const,
            text: revoke ? `Request-changes cleared on #${id}.` : `Changes requested on #${id}.`,
          },
        ],
        _meta: actMeta({ id: `#${id}`, url: prUrl(str(args.workspace), str(args.repoSlug), id) }),
      };
    }
  );

  // ——— Merge (with preview) ————————————————————————————————————————

  const mergeSchema = z.object({
    workspace: workspaceArg,
    repoSlug: repoArg,
    id: prIdArg,
    strategy: z
      .enum(['merge_commit', 'squash', 'fast_forward'])
      .describe('Merge strategy; default the repository’s configured one')
      .optional(),
    message: z.string().describe('Merge commit message; default Bitbucket’s').optional(),
    closeSourceBranch: z
      .boolean()
      .describe('Delete the source branch after merging; default the PR’s own setting')
      .optional(),
  });

  const mergeHandler = async (args: Record<string, any>) => {
    const workspace = str(args.workspace);
    const repoSlug = str(args.repoSlug);
    const id = Number(args.id);
    const result = await bbJson(
      auth,
      bitbucketScopeFor('bitbucket_merge_pull_request'),
      `${repoPath(workspace, repoSlug)}/pullrequests/${id}/merge`,
      {
        method: 'POST',
        json: {
          ...(str(args.strategy) ? { merge_strategy: str(args.strategy) } : {}),
          ...(str(args.message) ? { message: str(args.message) } : {}),
          ...(typeof args.closeSourceBranch === 'boolean'
            ? { close_source_branch: args.closeSourceBranch }
            : {}),
        },
      }
    );
    if (!result.ok) return errText(result.error);
    const url = prUrl(workspace, repoSlug, id);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Merged pull request #${id}` +
            (str(result.body.state) === 'MERGED' ? '' : ` — state ${str(result.body.state)}`) +
            `.\n\n[Open in Bitbucket](${url})`,
        },
      ],
      _meta: actMeta({ id: `#${id}`, url }),
    };
  };

  server.registerTool(
    'bitbucket_merge_pull_request',
    {
      title: 'Bitbucket · Act — Merge a pull request',
      description:
        'Merge a pull request into its destination branch. Prefer ' +
        'bitbucket_merge_pull_request_preview whenever the user should confirm first — a ' +
        'merge is not undoable from here.',
      annotations: { readOnlyHint: false },
      inputSchema: mergeSchema,
    },
    mergeHandler
  );

  server.registerTool(
    'bitbucket_merge_pull_request_preview',
    {
      title: 'Bitbucket · Act — Preview a merge before performing it',
      description:
        'Show the user an interactive card confirming a pull request merge. Prefer this over ' +
        'bitbucket_merge_pull_request whenever the user should confirm — the card does the ' +
        'merging.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: mergeSchema,
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const repoSlug = str(args.repoSlug);
      const id = Number(args.id);
      // Show what is actually about to merge — title, branches, approvals —
      // so the card is a decision, not a guess. A failed read still previews
      // with what was passed.
      let subtitle = `${workspace}/${repoSlug}`;
      const fields: { label: string; value: string }[] = [];
      const prResult = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_get_pull_request'),
        `${repoPath(workspace, repoSlug)}/pullrequests/${id}`
      );
      if (prResult.ok) {
        const pr = prResult.body;
        subtitle = `#${id} ${str(pr.title)}`;
        const participants = Array.isArray(pr.participants) ? pr.participants.map(rec) : [];
        const approvals = participants.filter(
          (participant) => participant.approved === true
        ).length;
        fields.push(
          {
            label: 'Branches',
            value: `${str(rec(rec(pr.source).branch).name)} → ${str(rec(rec(pr.destination).branch).name)}`,
          },
          { label: 'Approvals', value: String(approvals) }
        );
      }
      fields.push({
        label: 'Strategy',
        value: str(args.strategy) || 'repository default',
      });
      if (typeof args.closeSourceBranch === 'boolean') {
        fields.push({
          label: 'Source branch',
          value: args.closeSourceBranch ? 'delete after merge' : 'keep',
        });
      }
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `The merge of pull request #${id} is awaiting the user's decision on the ` +
              `preview card. Do not merge it another way; the user confirms or cancels from ` +
              `the card. If no card appeared in this client, ask the user how to proceed.`,
          },
        ],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: 'Merge pull request',
          subtitle,
          confirmTool: 'bitbucket_merge_pull_request_confirm',
          confirmLabel: 'Merge',
          confirmArgs: args,
          fields,
        },
      };
    }
  );

  server.registerTool(
    'bitbucket_merge_pull_request_confirm',
    {
      title: 'Bitbucket · Act — Merge a previewed pull request (card only)',
      description:
        'Merge a pull request the user approved on a preview card.' +
        confirmGuard('bitbucket_merge_pull_request_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: mergeSchema,
    },
    mergeHandler
  );

  server.registerTool(
    'bitbucket_decline_pull_request',
    {
      title: 'Bitbucket · Act — Decline a pull request',
      description:
        'Decline (close without merging) a pull request. It stays in history and can be ' +
        'reopened from the Bitbucket UI.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ workspace: workspaceArg, repoSlug: repoArg, id: prIdArg }),
    },
    async (args: Record<string, any>) => {
      const id = Number(args.id);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_decline_pull_request'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests/${id}/decline`,
        { method: 'POST', json: {} }
      );
      if (!result.ok) return errText(result.error);
      return {
        content: [{ type: 'text' as const, text: `Declined pull request #${id}.` }],
        _meta: actMeta({ id: `#${id}`, url: prUrl(str(args.workspace), str(args.repoSlug), id) }),
      };
    }
  );

  server.registerTool(
    'bitbucket_add_pr_comment',
    {
      title: 'Bitbucket · Act — Comment on a pull request',
      description:
        'Add a comment to a pull request — on the whole PR, inline on a file line (path + ' +
        'line), or as a reply to another comment (parentId).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        id: prIdArg,
        comment: z.string().min(1).describe('Comment text, markdown'),
        path: z.string().describe('File path, for an inline comment').optional(),
        line: z
          .number()
          .int()
          .min(1)
          .describe('Line in the new version of that file, for an inline comment')
          .optional(),
        parentId: z
          .number()
          .int()
          .describe('Comment id to reply under, from bitbucket_list_pr_comments')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const id = Number(args.id);
      const body: Record<string, unknown> = {
        content: { raw: str(args.comment) },
        ...(str(args.path)
          ? {
              inline: {
                path: str(args.path),
                ...(typeof args.line === 'number' ? { to: args.line } : {}),
              },
            }
          : {}),
        ...(typeof args.parentId === 'number' ? { parent: { id: args.parentId } } : {}),
      };
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_add_pr_comment'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests/${id}/comments`,
        { method: 'POST', json: body }
      );
      if (!result.ok) return errText(result.error);
      const url = prUrl(str(args.workspace), str(args.repoSlug), id);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Comment added to #${id} (comment ${num(result.body.id)}).`,
          },
        ],
        _meta: actMeta({ id: `#${id}`, url }),
      };
    }
  );

  server.registerTool(
    'bitbucket_resolve_pr_comment',
    {
      title: 'Bitbucket · Act — Resolve a pull request comment thread',
      description: 'Mark a comment thread resolved — or reopen it with reopen:true.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        id: prIdArg,
        commentId: z.number().int().min(1).describe('From bitbucket_list_pr_comments'),
        reopen: z.boolean().describe('Reopen instead of resolving').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const id = Number(args.id);
      const commentId = Number(args.commentId);
      const reopen = args.reopen === true;
      const response = await auth.fetch(
        bitbucketScopeFor('bitbucket_resolve_pr_comment'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests/${id}` +
          `/comments/${commentId}/resolve`,
        { method: reopen ? 'DELETE' : 'POST' }
      );
      if (!response.ok) return errText(await describeBitbucketFailure(response));
      return textResult(
        reopen ? `Comment ${commentId} reopened on #${id}.` : `Comment ${commentId} resolved on #${id}.`
      );
    }
  );

  server.registerTool(
    'bitbucket_list_pr_tasks',
    {
      title: 'Bitbucket · Read — List pull request tasks',
      description: 'A pull request’s tasks (the merge-blocking checklist), with their state.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ workspace: workspaceArg, repoSlug: repoArg, id: prIdArg }),
    },
    async (args: Record<string, any>) => {
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_pr_tasks'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests/${Number(args.id)}/tasks?pagelen=50`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (task) =>
          `${str(task.state) === 'RESOLVED' ? '[x]' : '[ ]'} ${str(rec(task.content).raw)}` +
          ` (task ${num(task.id)})`
      );
      if (lines.length === 0) return textResult('No tasks.');
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'bitbucket_add_pr_task',
    {
      title: 'Bitbucket · Act — Add a pull request task',
      description: 'Add a task (checklist item) to a pull request.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        id: prIdArg,
        task: z.string().min(1).describe('Task text'),
      }),
    },
    async (args: Record<string, any>) => {
      const id = Number(args.id);
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_add_pr_task'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pullrequests/${id}/tasks`,
        { method: 'POST', json: { content: { raw: str(args.task) }, pending: true } }
      );
      if (!result.ok) return errText(result.error);
      return {
        content: [
          { type: 'text' as const, text: `Task added to #${id} (task ${num(result.body.id)}).` },
        ],
        _meta: actMeta({ id: `#${id}`, url: prUrl(str(args.workspace), str(args.repoSlug), id) }),
      };
    }
  );
}

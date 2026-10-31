/**
 * The names behind the ids a GitHub act's preview card carries (see
 * ../lookup.ts): a pull request's title, the comment being resolved, the
 * workflow run being cancelled. Each lookup only reads, and a failure just
 * leaves the name out — the card then says "the comment", never an id.
 */

import type { MCPToolContext } from '../common';
import { registerPreviewLookups } from '../lookup';
import { nameKey, record, text, type Args, type Names } from '../previews/card';
import type { GitHubAuth } from './github-auth';
import { githubScopeFor } from './scopes';

const EXCERPT = 80;

const repoPath = (args: Args) =>
  `/repos/${encodeURIComponent(text(args.owner))}/${encodeURIComponent(text(args.repo))}`;

export function registerGitHubPreviewLookups(context: MCPToolContext, auth: GitHubAuth): void {
  const get = async (scopeTool: string, path: string): Promise<Args | null> => {
    try {
      const response = await auth.fetch(githubScopeFor(scopeTool), path);
      if (!response.ok) return null;
      return record(await response.json());
    } catch {
      return null;
    }
  };

  const pullRequest = async (args: Args): Promise<Names> => {
    const number = text(args.number);
    if (!number) return {};
    const found = await get(
      'github_get_pull_request',
      `${repoPath(args)}/pulls/${encodeURIComponent(number)}`
    );
    return text(found?.title) ? { [nameKey('pr', number)]: text(found?.title) } : {};
  };

  const reviewComment = async (args: Args): Promise<Names> => {
    const id = text(args.commentId);
    if (!id) return {};
    const found = await get(
      'github_list_pr_comments',
      `${repoPath(args)}/pulls/comments/${encodeURIComponent(id)}`
    );
    if (!found) return {};
    const author = text(record(found.user).login);
    const body = text(found.body).replace(/\s+/g, ' ');
    const excerpt = body.length > EXCERPT ? `${body.slice(0, EXCERPT)}…` : body;
    const label = [author ? `by ${author}` : '', excerpt ? `“${excerpt}”` : '']
      .filter(Boolean)
      .join(': ');
    return label ? { [nameKey('comment', id)]: label } : {};
  };

  const merge = async (...parts: Promise<Names>[]): Promise<Names> =>
    Object.assign({}, ...(await Promise.all(parts)));

  registerPreviewLookups(context, {
    github_add_pr_comment: pullRequest,
    github_update_pull_request: pullRequest,
    github_approve_pull_request: pullRequest,
    github_request_pr_changes: pullRequest,
    github_close_pull_request: pullRequest,
    github_resolve_pr_comment: async (args) => merge(pullRequest(args), reviewComment(args)),

    github_cancel_workflow_run: async (args) => {
      const id = text(args.runId);
      if (!id) return {};
      const found = await get(
        'github_get_workflow_run',
        `${repoPath(args)}/actions/runs/${encodeURIComponent(id)}`
      );
      if (!found) return {};
      const name = text(found.display_title) || text(found.name);
      const branch = text(found.head_branch);
      const label = [name, branch ? `on ${branch}` : ''].filter(Boolean).join(' ');
      return label ? { [nameKey('run', id)]: label } : {};
    },
  });
}

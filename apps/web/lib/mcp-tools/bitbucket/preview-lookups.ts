/**
 * The names behind the ids a Bitbucket act's preview card carries (see
 * ../lookup.ts): a pull request's title, the comment being resolved or
 * replied to, the pipeline being stopped, the person being given access, a
 * project's name. Each lookup only reads, and a failure just leaves the
 * name out — the card then says "the comment", never an id.
 */

import type { MCPToolContext } from '../common';
import { registerPreviewLookups } from '../lookup';
import { nameKey, record, text, type Args, type Names } from '../previews/card';
import type { BitbucketAuth } from './bitbucket-auth';
import { bitbucketScopeFor } from './scopes';

const EXCERPT = 80;

const repoPath = (args: Args) =>
  `/repositories/${encodeURIComponent(text(args.workspace))}/${encodeURIComponent(text(args.repoSlug))}`;

/** Brace-wrapped, then encoded — the API's own shape for a uuid segment. */
function uuidSegment(raw: string): string {
  return encodeURIComponent(/^\{.*\}$/.test(raw) ? raw : `{${raw}}`);
}

export function registerBitbucketPreviewLookups(
  context: MCPToolContext,
  auth: BitbucketAuth
): void {
  const get = async (scopeTool: string, path: string): Promise<Args | null> => {
    try {
      const response = await auth.fetch(bitbucketScopeFor(scopeTool), path);
      if (!response.ok) return null;
      return record(await response.json());
    } catch {
      return null;
    }
  };

  const pullRequest = async (args: Args): Promise<Names> => {
    const id = text(args.id);
    if (!id) return {};
    const found = await get(
      'bitbucket_get_pull_request',
      `${repoPath(args)}/pullrequests/${encodeURIComponent(id)}`
    );
    return text(found?.title) ? { [nameKey('pr', id)]: text(found?.title) } : {};
  };

  const comment = async (args: Args, key: unknown): Promise<Names> => {
    const id = text(key);
    if (!id || !text(args.id)) return {};
    const found = await get(
      'bitbucket_list_pr_comments',
      `${repoPath(args)}/pullrequests/${encodeURIComponent(text(args.id))}/comments/${encodeURIComponent(id)}`
    );
    if (!found) return {};
    const author = text(record(found.user).display_name);
    const body = text(record(found.content).raw).replace(/\s+/g, ' ');
    const excerpt = body.length > EXCERPT ? `${body.slice(0, EXCERPT)}…` : body;
    const label = [author ? `by ${author}` : '', excerpt ? `“${excerpt}”` : '']
      .filter(Boolean)
      .join(': ');
    return label ? { [nameKey('comment', id)]: label } : {};
  };

  const user = async (args: Args): Promise<Names> => {
    const id = text(args.userId);
    if (!id) return {};
    const found = await get('bitbucket_list_workspace_members', `/users/${encodeURIComponent(id)}`);
    return text(found?.display_name) ? { [nameKey('user', id)]: text(found?.display_name) } : {};
  };

  const project = async (args: Args): Promise<Names> => {
    const key = text(args.key) || text(args.projectKey);
    if (!key || !text(args.workspace)) return {};
    const found = await get(
      'bitbucket_get_project',
      `/workspaces/${encodeURIComponent(text(args.workspace))}/projects/${encodeURIComponent(key)}`
    );
    return text(found?.name) ? { [nameKey('project', key)]: text(found?.name) } : {};
  };

  const merge = async (...parts: Promise<Names>[]): Promise<Names> =>
    Object.assign({}, ...(await Promise.all(parts)));

  registerPreviewLookups(context, {
    bitbucket_add_pr_comment: async (args) =>
      merge(pullRequest(args), comment(args, args.parentId)),
    bitbucket_add_pr_task: pullRequest,
    bitbucket_update_pull_request: pullRequest,
    bitbucket_approve_pull_request: pullRequest,
    bitbucket_request_pr_changes: pullRequest,
    bitbucket_decline_pull_request: pullRequest,
    bitbucket_resolve_pr_comment: async (args) =>
      merge(pullRequest(args), comment(args, args.commentId)),

    bitbucket_grant_repository_permission: user,
    bitbucket_revoke_repository_permission: user,

    bitbucket_update_project: project,
    bitbucket_delete_project: project,

    bitbucket_stop_pipeline: async (args) => {
      const raw = text(args.pipelineUuid);
      if (!raw) return {};
      const found = await get(
        'bitbucket_get_pipeline',
        `${repoPath(args)}/pipelines/${uuidSegment(raw)}`
      );
      if (!found) return {};
      const number = text(found.build_number);
      const target = text(record(found.target).ref_name);
      const label = [number ? `Pipeline #${number}` : '', target ? `on ${target}` : '']
        .filter(Boolean)
        .join(' ');
      return label ? { [nameKey('pipeline', raw)]: label } : {};
    },
  });
}

/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { MCPToolContext } from '../common';
import { lookupNames } from '../lookup';
import type { BitbucketAuth } from './bitbucket-auth';
import { registerBitbucketPreviewLookups } from './preview-lookups';

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

function setup(answer: (path: string) => Response) {
  const calls: string[] = [];
  const auth: BitbucketAuth = {
    kind: 'oauth',
    fetch: jest.fn(async (_scopes: readonly string[], path: string) => {
      calls.push(path);
      return answer(path);
    }),
  };
  const context = {} as MCPToolContext;
  registerBitbucketPreviewLookups(context, auth);
  return { context, calls };
}

const base = { workspace: 'acme', repoSlug: 'web' };

describe('Bitbucket preview lookups', () => {
  it('reads the pull request title and the comment being resolved', async () => {
    const { context } = setup((path) =>
      path.endsWith('/comments/55')
        ? json({ user: { display_name: 'Ann Lee' }, content: { raw: 'Rename this' } })
        : json({ title: 'Fix the login' })
    );
    expect(
      await lookupNames(context, 'bitbucket_resolve_pr_comment', { ...base, id: 12, commentId: 55 })
    ).toEqual({ 'pr:12': 'Fix the login', 'comment:55': 'by Ann Lee: “Rename this”' });
  });

  it('names a pipeline, a person and a project', async () => {
    const uuid = '{abc-123}';
    const { context, calls } = setup((path) => {
      if (path.includes('/pipelines/'))
        return json({ build_number: 42, target: { ref_name: 'main' } });
      if (path.startsWith('/users/')) return json({ display_name: 'Ann Lee' });
      return json({ name: 'Platform' });
    });
    expect(
      await lookupNames(context, 'bitbucket_stop_pipeline', { ...base, pipelineUuid: uuid })
    ).toEqual({
      [`pipeline:${uuid}`]: 'Pipeline #42 on main',
    });
    expect(calls[0]).toBe('/repositories/acme/web/pipelines/%7Babc-123%7D');
    expect(
      await lookupNames(context, 'bitbucket_grant_repository_permission', {
        ...base,
        userId: '{u-1}',
      })
    ).toEqual({ 'user:{u-1}': 'Ann Lee' });
    expect(
      await lookupNames(context, 'bitbucket_delete_project', { workspace: 'acme', key: 'PRJ' })
    ).toEqual({ 'project:PRJ': 'Platform' });
  });

  it('leaves names out when Bitbucket refuses or fails', async () => {
    const refused = setup(() => json({}, false));
    expect(
      await lookupNames(refused.context, 'bitbucket_approve_pull_request', { ...base, id: 12 })
    ).toEqual({});
    const broken = setup(() => {
      throw new Error('offline');
    });
    expect(
      await lookupNames(broken.context, 'bitbucket_stop_pipeline', { ...base, pipelineUuid: 'x' })
    ).toEqual({});
  });
});

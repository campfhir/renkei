/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { MCPToolContext } from '../common';
import { lookupNames } from '../lookup';
import type { GitHubAuth } from './github-auth';
import { registerGitHubPreviewLookups } from './preview-lookups';

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

function setup(answer: (path: string) => Response) {
  const calls: string[] = [];
  const auth: GitHubAuth = {
    kind: 'oauth',
    fetch: jest.fn(async (_scopes: readonly string[], path: string) => {
      calls.push(path);
      return answer(path);
    }),
  };
  const context = {} as MCPToolContext;
  registerGitHubPreviewLookups(context, auth);
  return { context, calls };
}

const base = { owner: 'acme', repo: 'web' };

describe('GitHub preview lookups', () => {
  it('reads the pull request title and the comment being resolved', async () => {
    const { context, calls } = setup((path) =>
      path.endsWith('/pulls/comments/55')
        ? json({ user: { login: 'ann' }, body: 'Please\nrename this' })
        : json({ title: 'Fix the login' })
    );
    const names = await lookupNames(context, 'github_resolve_pr_comment', {
      ...base,
      number: 12,
      commentId: 55,
    });
    expect(names).toEqual({
      'pr:12': 'Fix the login',
      'comment:55': 'by ann: “Please rename this”',
    });
    expect(calls).toEqual(
      expect.arrayContaining(['/repos/acme/web/pulls/12', '/repos/acme/web/pulls/comments/55'])
    );
  });

  it('names a workflow run by its title and branch', async () => {
    const { context } = setup(() => json({ display_title: 'Fix tests', head_branch: 'main' }));
    expect(
      await lookupNames(context, 'github_cancel_workflow_run', { ...base, runId: '77' })
    ).toEqual({
      'run:77': 'Fix tests on main',
    });
  });

  it('leaves names out when GitHub refuses or fails', async () => {
    const refused = setup(() => json({}, false));
    expect(
      await lookupNames(refused.context, 'github_approve_pull_request', { ...base, number: 12 })
    ).toEqual({});
    const broken = setup(() => {
      throw new Error('offline');
    });
    expect(
      await lookupNames(broken.context, 'github_cancel_workflow_run', { ...base, runId: '77' })
    ).toEqual({});
  });
});

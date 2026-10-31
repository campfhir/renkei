import { nameKey } from './card';
import { PREVIEW_BUILDERS } from '.';

const GH = { owner: 'acme', repo: 'web' };
const BB = { workspace: 'acme', repoSlug: 'web' };

const card = (tool: string, args: Record<string, unknown>, names: Record<string, string> = {}) =>
  JSON.stringify(PREVIEW_BUILDERS[tool]!(args, names));

describe('source control cards show names, not ids', () => {
  it('names the pull request by its title when known', () => {
    const names = { [nameKey('pr', '12')]: 'Fix the login' };
    expect(card('github_approve_pull_request', { ...GH, number: 12 }, names)).toContain(
      '#12 Fix the login'
    );
    expect(card('bitbucket_decline_pull_request', { ...BB, id: 12 }, names)).toContain(
      '#12 Fix the login'
    );
  });

  it('shows the looked-up comment, and "the comment" without one, never the comment id', () => {
    const args = { ...GH, number: 12, commentId: 987654321 };
    const withName = card('github_resolve_pr_comment', args, {
      [nameKey('comment', '987654321')]: 'by Ann: “Looks good”',
    });
    expect(withName).toContain('by Ann');
    expect(withName).not.toContain('987654321');
    const without = card('github_resolve_pr_comment', args);
    expect(without).not.toContain('987654321');
    expect(PREVIEW_BUILDERS.github_resolve_pr_comment!(args, {}).body).toMatchObject({
      commentLabel: '',
    });
  });

  it('says a workflow run / pipeline, never the run id or uuid', () => {
    const run = card('github_cancel_workflow_run', { ...GH, runId: '9988776655' });
    expect(run).toContain('Cancel a workflow run');
    expect(run).not.toContain('9988776655');
    const named = card(
      'github_cancel_workflow_run',
      { ...GH, runId: '9988776655' },
      { [nameKey('run', '9988776655')]: 'CI on main' }
    );
    expect(named).toContain('CI on main');
    expect(named).not.toContain('9988776655');

    const uuid = '{1b2c3d4e-0000-4000-8000-123456789abc}';
    const pipeline = card('bitbucket_stop_pipeline', { ...BB, pipelineUuid: uuid });
    expect(pipeline).toContain('Stop a pipeline');
    expect(pipeline).not.toContain('1b2c3d4e');
    expect(
      card(
        'bitbucket_stop_pipeline',
        { ...BB, pipelineUuid: uuid },
        { [nameKey('pipeline', uuid)]: 'Pipeline #42 on main' }
      )
    ).toContain('Pipeline #42 on main');
  });

  it('names a Bitbucket person, and hides an unresolved uuid, but keeps a typed login', () => {
    const uuid = '{1b2c3d4e-0000-4000-8000-123456789abc}';
    const args = { ...BB, userId: uuid, permission: 'write' };
    expect(
      card('bitbucket_grant_repository_permission', args, { [nameKey('user', uuid)]: 'Ann Lee' })
    ).toContain('Give Ann Lee write access');
    const generic = card('bitbucket_grant_repository_permission', args);
    expect(generic).toContain('a workspace member');
    expect(generic).not.toContain('1b2c3d4e');
    expect(card('bitbucket_revoke_repository_permission', { ...BB, userId: 'ann-lee' })).toContain(
      'ann-lee'
    );
    expect(
      card('github_grant_repository_permission', { ...GH, username: 'octocat', permission: 'push' })
    ).toContain('octocat');
  });

  it('uses the project name when looked up', () => {
    const named = card(
      'bitbucket_delete_project',
      { workspace: 'acme', key: 'PRJ' },
      { [nameKey('project', 'PRJ')]: 'Platform' }
    );
    expect(named).toContain('Delete the project Platform');
  });
});

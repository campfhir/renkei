import { milestoneKindOf, milestoneSentence, milestoneSummary } from './milestones';

describe('milestoneKindOf', () => {
  it('lifts the chat’s own git verbs and the host acts on pull requests, commits and branches', () => {
    expect(milestoneKindOf('code_git_commit')).toBe('act');
    expect(milestoneKindOf('code_git_push')).toBe('act');
    expect(milestoneKindOf('code_git_pull')).toBe('act');
    expect(milestoneKindOf('bitbucket_create_pull_request')).toBe('act');
    expect(milestoneKindOf('bitbucket_create_pull_request_preview')).toBe('act');
    expect(milestoneKindOf('bitbucket_merge_pull_request_confirm')).toBe('act');
    expect(milestoneKindOf('bitbucket_decline_pull_request')).toBe('act');
    expect(milestoneKindOf('bitbucket_commit_files')).toBe('act');
    expect(milestoneKindOf('bitbucket_create_branch')).toBe('act');
    expect(milestoneKindOf('github_create_pull_request')).toBe('act');
    expect(milestoneKindOf('github_merge_pull_request_preview')).toBe('act');
    expect(milestoneKindOf('github_close_pull_request')).toBe('act');
    expect(milestoneKindOf('github_commit_file')).toBe('act');
    expect(milestoneKindOf('github_delete_branch')).toBe('act');
  });

  it('folds every host read like any other tool call', () => {
    expect(milestoneKindOf('bitbucket_get_pull_request')).toBeNull();
    expect(milestoneKindOf('bitbucket_list_pipelines')).toBeNull();
    expect(milestoneKindOf('bitbucket_read_file')).toBeNull();
    expect(milestoneKindOf('bitbucket_list_branches')).toBeNull();
    expect(milestoneKindOf('bitbucket_get_repository')).toBeNull();
    expect(milestoneKindOf('github_list_commits')).toBeNull();
    expect(milestoneKindOf('github_read_file')).toBeNull();
    expect(milestoneKindOf('github_get_workflow_run')).toBeNull();
  });

  it('folds the host’s quieter acts too: comments, pipelines, permissions', () => {
    expect(milestoneKindOf('bitbucket_add_pr_comment')).toBeNull();
    expect(milestoneKindOf('bitbucket_trigger_pipeline')).toBeNull();
    expect(milestoneKindOf('bitbucket_grant_repository_permission')).toBeNull();
    expect(milestoneKindOf('github_trigger_workflow_preview')).toBeNull();
    expect(milestoneKindOf('github_cancel_workflow_run')).toBeNull();
  });

  it('leaves the file tools, the clone step and other connectors in the fold', () => {
    expect(milestoneKindOf('code_read_file')).toBeNull();
    expect(milestoneKindOf('code_git_status')).toBeNull();
    expect(milestoneKindOf('code_clone')).toBeNull();
    expect(milestoneKindOf('jira_create_issue')).toBeNull();
  });
});

describe('milestoneSentence', () => {
  it('has a sentence per state for the known tools', () => {
    expect(milestoneSentence('code_git_commit', 'pending')).toBe('Committing');
    expect(milestoneSentence('code_git_push', 'done')).toBe('Pushed to the remote');
    expect(milestoneSentence('bitbucket_create_pull_request_confirm', 'done')).toBe(
      'Opened a pull request'
    );
    expect(milestoneSentence('bitbucket_merge_pull_request', 'failed')).toBe('The merge failed');
    expect(milestoneSentence('bitbucket_create_pull_request', 'waiting')).toBe(
      'Waiting for permission: opening a pull request'
    );
  });

  it('falls back to the tool’s friendly name for the rest', () => {
    expect(milestoneSentence('bitbucket_list_workspaces', 'pending')).toMatch(/^Calling /);
    expect(milestoneSentence('bitbucket_list_workspaces', 'done')).toMatch(/^Called /);
  });
});

describe('milestoneSummary', () => {
  it('takes the result’s first line and its link', () => {
    expect(
      milestoneSummary(
        'Created pull request #12: Fix the timeout\nfeat/x → main\n\n[Open in Bitbucket](https://bitbucket.org/acme/demo/pull-requests/12)'
      )
    ).toEqual({
      headline: 'Created pull request #12: Fix the timeout',
      link: { label: 'Open in Bitbucket', url: 'https://bitbucket.org/acme/demo/pull-requests/12' },
    });
    expect(milestoneSummary('Committed on feat/x: 1a2b3c4 Fix the timeout')).toEqual({
      headline: 'Committed on feat/x: 1a2b3c4 Fix the timeout',
      link: null,
    });
  });

  it('flattens a link inside the first line and refuses a line that is a document', () => {
    expect(milestoneSummary('See [PR #3](https://x.test/3) for details').headline).toBe(
      'See PR #3 for details'
    );
    expect(milestoneSummary('{"id": 3, "title": "x"}').headline).toBeNull();
    expect(milestoneSummary('| a | b |').headline).toBeNull();
    expect(milestoneSummary('').headline).toBeNull();
  });

  it('clips a long first line', () => {
    const long = 'x'.repeat(400);
    expect(milestoneSummary(long).headline).toHaveLength(160);
    expect(milestoneSummary(long).headline?.endsWith('…')).toBe(true);
  });
});

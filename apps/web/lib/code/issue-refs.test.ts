import { detectIssueRefs } from './issue-refs';

describe('detectIssueRefs', () => {
  it('reads a Jira key and a GitHub issue ref from the PR title', () => {
    expect(
      detectIssueRefs({
        prTitle: 'PROJ-123: fix the retry loop (closes #41)',
        prNumber: 42,
        branch: 'feat/x',
      })
    ).toEqual({ jiraKey: 'PROJ-123', githubIssueNumber: 41 });
  });

  it('excludes a GitHub ref equal to the PR’s own number', () => {
    expect(detectIssueRefs({ prTitle: 'See #42 for context', prNumber: 42 })).toEqual({
      jiraKey: null,
      githubIssueNumber: null,
    });
  });

  it('falls back to the branch name when the title names nothing', () => {
    // A title present but silent on the issue never falls through to the
    // branch — and a lowercase branch never matches the key pattern anyway.
    expect(
      detectIssueRefs({ prTitle: 'Fix the retry loop', branch: 'proj-123-retry-loop' })
    ).toEqual({ jiraKey: null, githubIssueNumber: null });
    expect(detectIssueRefs({ branch: 'PROJ-123-retry-loop' })).toEqual({
      jiraKey: 'PROJ-123',
      githubIssueNumber: null,
    });
  });

  it('is empty when nothing looks like an issue reference', () => {
    expect(detectIssueRefs({ prTitle: 'Tidy up the tests', branch: 'chore/tests' })).toEqual({
      jiraKey: null,
      githubIssueNumber: null,
    });
  });
});

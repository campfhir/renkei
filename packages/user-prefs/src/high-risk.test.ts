import {
  DEFAULT_HIGH_RISK_PREFS,
  highRiskByDefault,
  highRiskTest,
  isHighRisk,
  parseHighRiskPrefs,
  withHighRisk,
} from './high-risk';

const LOCKED = ['outlook_send_mail', 'github_merge_pull_request'];

describe('high-risk lists', () => {
  it('for agents, nothing is high risk until the person or the organization says so', () => {
    expect(isHighRisk(DEFAULT_HIGH_RISK_PREFS, 'agents', 'jira_create_issue', [])).toBe(false);
    expect(isHighRisk(DEFAULT_HIGH_RISK_PREFS, 'agents', 'outlook_send_mail', LOCKED)).toBe(true);
  });

  it("for code projects, everything is high risk but the checkout's, the sandbox's and the chat's own tools", () => {
    for (const work of [
      'code_git_commit',
      'code_git_push',
      'code_git_pull',
      'sandbox_run',
      'chat_write_file',
    ]) {
      expect(highRiskByDefault('code', work)).toBe(false);
    }
    for (const outside of [
      'github_create_pull_request',
      'jira_create_issue',
      'some_tool_from_later',
    ]) {
      expect(highRiskByDefault('code', outside)).toBe(true);
    }
  });

  it('a locked tool stays high risk whatever the person unmarked', () => {
    const prefs = withHighRisk(DEFAULT_HIGH_RISK_PREFS, 'code', 'github_merge_pull_request', false);
    expect(prefs.unmarked).toEqual(['github_merge_pull_request']);
    expect(isHighRisk(prefs, 'code', 'github_merge_pull_request', LOCKED)).toBe(true);
    expect(highRiskTest(prefs, 'code', LOCKED)('github_merge_pull_request')).toBe(true);
  });

  it('keeps only departures from the default, so switching back leaves both lists empty', () => {
    const marked = withHighRisk(DEFAULT_HIGH_RISK_PREFS, 'agents', 'jira_create_issue', true);
    expect(marked).toEqual({ marked: ['jira_create_issue'], unmarked: [] });
    expect(withHighRisk(marked, 'agents', 'jira_create_issue', false)).toEqual(
      DEFAULT_HIGH_RISK_PREFS
    );
    const unmarked = withHighRisk(DEFAULT_HIGH_RISK_PREFS, 'code', 'jira_create_issue', false);
    expect(unmarked).toEqual({ marked: [], unmarked: ['jira_create_issue'] });
    expect(withHighRisk(unmarked, 'code', 'jira_create_issue', true)).toEqual(
      DEFAULT_HIGH_RISK_PREFS
    );
  });

  it('the person can mark a code tool high risk, and unmark one the default holds', () => {
    let prefs = withHighRisk(DEFAULT_HIGH_RISK_PREFS, 'code', 'code_git_push', true);
    prefs = withHighRisk(prefs, 'code', 'github_create_pull_request', false);
    const test = highRiskTest(prefs, 'code', []);
    expect(test('code_git_push')).toBe(true);
    expect(test('github_create_pull_request')).toBe(false);
    expect(test('code_git_commit')).toBe(false);
    expect(test('jira_delete_issue')).toBe(true);
  });

  it('reads whatever was stored, dropping what is not a tool name; marked wins a tie', () => {
    expect(parseHighRiskPrefs(null)).toEqual(DEFAULT_HIGH_RISK_PREFS);
    expect(parseHighRiskPrefs(['x'])).toEqual(DEFAULT_HIGH_RISK_PREFS);
    expect(
      parseHighRiskPrefs({ marked: ['b', 'a', 'a', 'bad name', 4], unmarked: ['a', 'c'] })
    ).toEqual({ marked: ['a', 'b'], unmarked: ['c'] });
  });
});

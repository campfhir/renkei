/**
 * When an agent's staged batch waits for its owner: an action it is not
 * allowed to run without asking, a tool the organization locks, or the
 * org's policy. Which tools are allowed and locked is the caller's (the
 * agent's allowed actions, the org setting); this pins the decision.
 */

import { actApprovalReason, isExternallyTriggered } from './act-approval';

const isLocked = (tool: string) => tool === 'outlook_send_mail';

describe('isExternallyTriggered', () => {
  it('reads an event or API-key start as external, a person or a schedule as not', () => {
    expect(isExternallyTriggered('event')).toBe(true);
    expect(isExternallyTriggered('api')).toBe(true);
    expect(isExternallyTriggered('manual')).toBe(false);
    expect(isExternallyTriggered('chat')).toBe(false);
    expect(isExternallyTriggered('schedule')).toBe(false);
  });

  it('fails closed on a chained run whose root could not be resolved', () => {
    expect(isExternallyTriggered('agent')).toBe(true);
    expect(isExternallyTriggered('')).toBe(true);
  });
});

describe('actApprovalReason', () => {
  const allowed =
    (...tools: string[]) =>
    (tool: string) =>
      tools.includes(tool);
  const base = {
    tools: ['jira_add_comment'],
    isLocked,
    isAllowed: allowed('jira_add_comment'),
  };

  it('waits for the owner when any action is not one the agent may run without asking', () => {
    for (const policy of ['off', 'all', 'externally_triggered'] as const) {
      expect(
        actApprovalReason({
          ...base,
          tools: ['jira_add_comment', 'jira_create_issue'],
          policy,
          externallyTriggered: false,
        })
      ).toBe('owner');
    }
  });

  it('runs a batch of allowed actions on a manual run under the default policy, not on an externally triggered one', () => {
    expect(
      actApprovalReason({ ...base, policy: 'externally_triggered', externallyTriggered: false })
    ).toBeNull();
    expect(
      actApprovalReason({ ...base, policy: 'externally_triggered', externallyTriggered: true })
    ).toBe('policy');
  });

  it("never runs one unasked under 'all', always under 'off'", () => {
    expect(actApprovalReason({ ...base, policy: 'all', externallyTriggered: false })).toBe(
      'policy'
    );
    expect(actApprovalReason({ ...base, policy: 'off', externallyTriggered: true })).toBeNull();
  });

  it('holds a batch with a tool the organization locks, even one the agent is allowed', () => {
    expect(
      actApprovalReason({
        tools: ['jira_add_comment', 'outlook_send_mail'],
        isLocked,
        isAllowed: allowed('jira_add_comment', 'outlook_send_mail'),
        policy: 'off',
        externallyTriggered: false,
      })
    ).toBe('high-risk');
  });
});

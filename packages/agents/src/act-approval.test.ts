/**
 * The org policy and the high-risk tools, as the engine reads them. Which
 * tools are high risk is the caller's (the org's locked list and the
 * owner's own); this pins the decision itself.
 */

import { actApprovalReason, isExternallyTriggered } from './act-approval';

const isHighRisk = (tool: string) => tool === 'outlook_send_mail';

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
  const base = { tools: ['jira_add_comment'], autoAccept: true, isHighRisk };

  it('waits for the owner when the agent does not auto-accept, whatever the policy', () => {
    for (const policy of ['off', 'all', 'externally_triggered'] as const) {
      expect(
        actApprovalReason({ ...base, autoAccept: false, policy, externallyTriggered: false })
      ).toBe('owner');
    }
  });

  it('honors auto-accept on a manual run under the default, not on an externally triggered one', () => {
    expect(
      actApprovalReason({ ...base, policy: 'externally_triggered', externallyTriggered: false })
    ).toBeNull();
    expect(
      actApprovalReason({ ...base, policy: 'externally_triggered', externallyTriggered: true })
    ).toBe('policy');
  });

  it("never honors auto-accept under 'all', always under 'off'", () => {
    expect(actApprovalReason({ ...base, policy: 'all', externallyTriggered: false })).toBe(
      'policy'
    );
    expect(actApprovalReason({ ...base, policy: 'off', externallyTriggered: true })).toBeNull();
  });

  it('holds a batch with any high-risk tool for a person under every setting', () => {
    expect(
      actApprovalReason({
        tools: ['jira_add_comment', 'outlook_send_mail'],
        isHighRisk,
        autoAccept: true,
        policy: 'off',
        externallyTriggered: false,
      })
    ).toBe('high-risk');
  });

  it('lets an auto-accepted batch through when nothing in it is high risk for its owner', () => {
    expect(
      actApprovalReason({
        tools: ['outlook_send_mail'],
        isHighRisk: () => false,
        autoAccept: true,
        policy: 'off',
        externallyTriggered: false,
      })
    ).toBeNull();
  });
});

/**
 * The org policy and the fixed high-risk list, as the engine reads them.
 * Which NAMES the list may hold is apps/web's high-risk-tools test, against
 * the registered catalog; this pins the decision itself.
 */

import {
  ALWAYS_APPROVAL_TOOLS,
  actApprovalReason,
  isAlwaysApprovalTool,
  isExternallyTriggered,
} from './act-approval';

describe('isExternallyTriggered', () => {
  it('reads an event or API-key start as external, a person or a schedule as not', () => {
    expect(isExternallyTriggered('event')).toBe(true);
    expect(isExternallyTriggered('api')).toBe(true);
    expect(isExternallyTriggered('manual')).toBe(false);
    expect(isExternallyTriggered('schedule')).toBe(false);
  });

  it('fails closed on a chained run whose root could not be resolved', () => {
    expect(isExternallyTriggered('agent')).toBe(true);
    expect(isExternallyTriggered('')).toBe(true);
  });
});

describe('actApprovalReason', () => {
  const base = { tools: ['jira_add_comment'], autoAccept: true };

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
        autoAccept: true,
        policy: 'off',
        externallyTriggered: false,
      })
    ).toBe('high-risk');
  });
});

describe('ALWAYS_APPROVAL_TOOLS', () => {
  it('is what isAlwaysApprovalTool answers from', () => {
    for (const tool of ALWAYS_APPROVAL_TOOLS) expect(isAlwaysApprovalTool(tool)).toBe(true);
    expect(isAlwaysApprovalTool('jira_search_issues')).toBe(false);
  });
});

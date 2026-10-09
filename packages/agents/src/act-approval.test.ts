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
  const base = { tool: 'jira_add_comment', kind: 'act' as const, authorGated: false };

  it('pauses an act call on an externally triggered run under the default, not a manual one', () => {
    expect(
      actApprovalReason({ ...base, policy: 'externally_triggered', externallyTriggered: true })
    ).toBe('policy');
    expect(
      actApprovalReason({ ...base, policy: 'externally_triggered', externallyTriggered: false })
    ).toBeNull();
  });

  it('never pauses a read, whatever the policy', () => {
    for (const policy of ['externally_triggered', 'all', 'off'] as const) {
      expect(
        actApprovalReason({ ...base, kind: 'read', policy, externallyTriggered: true })
      ).toBeNull();
    }
  });

  it("'all' pauses every act call; 'off' pauses none the author did not gate", () => {
    expect(actApprovalReason({ ...base, policy: 'all', externallyTriggered: false })).toBe(
      'policy'
    );
    expect(actApprovalReason({ ...base, policy: 'off', externallyTriggered: true })).toBeNull();
    expect(
      actApprovalReason({ ...base, authorGated: true, policy: 'off', externallyTriggered: false })
    ).toBe('author');
  });

  it('treats an unknown kind as act — the conservative reading', () => {
    expect(
      actApprovalReason({
        ...base,
        kind: null,
        policy: 'externally_triggered',
        externallyTriggered: true,
      })
    ).toBe('policy');
  });

  it('a high-risk tool pauses under every policy, even on a manual run', () => {
    expect(isAlwaysApprovalTool('outlook_send_mail')).toBe(true);
    expect(isAlwaysApprovalTool('jira_add_comment')).toBe(false);
    for (const tool of ALWAYS_APPROVAL_TOOLS) {
      expect(
        actApprovalReason({
          tool,
          kind: 'act',
          authorGated: false,
          policy: 'off',
          externallyTriggered: false,
        })
      ).toBe('high-risk');
    }
  });

  it('the fixed list has no duplicates and no card-only confirm tools', () => {
    expect(new Set(ALWAYS_APPROVAL_TOOLS).size).toBe(ALWAYS_APPROVAL_TOOLS.length);
    expect(ALWAYS_APPROVAL_TOOLS.some((tool) => tool.endsWith('_confirm'))).toBe(false);
  });
});

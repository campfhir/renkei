import {
  DEFAULT_CHAT_TOOL_PERMISSION_PREFS,
  parseChatToolPermissionPrefs,
  ruleFor,
  withRule,
} from './permission-rules';

describe('parseChatToolPermissionPrefs', () => {
  it('reads an empty or malformed document as "ask every time"', () => {
    expect(parseChatToolPermissionPrefs(undefined)).toEqual(DEFAULT_CHAT_TOOL_PERMISSION_PREFS);
    expect(parseChatToolPermissionPrefs(null)).toEqual(DEFAULT_CHAT_TOOL_PERMISSION_PREFS);
    expect(parseChatToolPermissionPrefs('yes')).toEqual(DEFAULT_CHAT_TOOL_PERMISSION_PREFS);
    expect(parseChatToolPermissionPrefs({ alwaysAllow: 'jira_create_issue' })).toEqual(
      DEFAULT_CHAT_TOOL_PERMISSION_PREFS
    );
  });

  it('keeps well-formed tool names, deduplicated and sorted', () => {
    expect(
      parseChatToolPermissionPrefs({
        alwaysAllow: [
          'webex_send_message',
          'jira_create_issue',
          'jira_create_issue',
          42,
          'bad name',
        ],
      })
    ).toEqual({ alwaysAllow: ['jira_create_issue', 'webex_send_message'], alwaysDeny: [] });
  });

  it('reads a document from before the block list existed', () => {
    expect(parseChatToolPermissionPrefs({ alwaysAllow: ['jira_create_issue'] })).toEqual({
      alwaysAllow: ['jira_create_issue'],
      alwaysDeny: [],
    });
  });

  it('lets a block win over an allow for the same name', () => {
    expect(
      parseChatToolPermissionPrefs({
        alwaysAllow: ['jira_create_issue', 'jira_delete_issue'],
        alwaysDeny: ['jira_delete_issue'],
      })
    ).toEqual({ alwaysAllow: ['jira_create_issue'], alwaysDeny: ['jira_delete_issue'] });
  });
});

describe('ruleFor / withRule', () => {
  const prefs = parseChatToolPermissionPrefs({
    alwaysAllow: ['jira_create_issue'],
    alwaysDeny: ['jira_delete_issue'],
  });

  it('answers ask, allow or deny for a name', () => {
    expect(ruleFor(prefs, 'jira_create_issue')).toBe('allow');
    expect(ruleFor(prefs, 'jira_delete_issue')).toBe('deny');
    expect(ruleFor(prefs, 'webex_send_message')).toBe('ask');
  });

  it('moves a name between the lists, and off both for ask', () => {
    expect(withRule(prefs, 'jira_create_issue', 'deny')).toEqual({
      alwaysAllow: [],
      alwaysDeny: ['jira_create_issue', 'jira_delete_issue'],
    });
    expect(withRule(prefs, 'jira_delete_issue', 'ask')).toEqual({
      alwaysAllow: ['jira_create_issue'],
      alwaysDeny: [],
    });
    expect(withRule(prefs, 'webex_send_message', 'allow')).toEqual({
      alwaysAllow: ['jira_create_issue', 'webex_send_message'],
      alwaysDeny: ['jira_delete_issue'],
    });
  });
});

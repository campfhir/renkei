import {
  DEFAULT_CHAT_TOOL_PERMISSION_PREFS,
  parseChatToolPermissionPrefs,
} from './permission-prefs';

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
    ).toEqual({ alwaysAllow: ['jira_create_issue', 'webex_send_message'] });
  });
});

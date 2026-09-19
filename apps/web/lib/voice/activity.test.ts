/**
 * The spoken line for a tool call, pinned for the shapes that exist:
 * connector tools by verb and noun, the code tools' own sentences, the
 * chat's own tools by name, and a fallback that is at least true.
 */

import { spokenActivity, spokenAsk } from './activity';

describe('spokenActivity', () => {
  it('turns a connector tool into what it is doing, naming the connector', () => {
    expect(spokenActivity('jira_search_issues')).toBe('Searching Jira issues');
    expect(spokenActivity('outlook_find_meeting_times')).toBe('Finding Outlook meeting times');
    expect(spokenActivity('confluence_create_page')).toBe('Creating Confluence page');
    expect(spokenActivity('jsm_ops_list_alerts')).toBe('Listing Jira operations alerts');
  });

  it('drops the preview and confirm suffixes', () => {
    expect(spokenActivity('jira_create_issue_preview')).toBe('Creating Jira issue');
  });

  it('uses the code tools own sentences and verbs', () => {
    expect(spokenActivity('code_clone')).toBe('Cloning the repository');
    expect(spokenActivity('code_grep')).toBe('Searching the code');
    expect(spokenActivity('code_edit_file')).toBe('Editing a file');
  });

  it('names the chat own tools as what they mean', () => {
    expect(spokenActivity('web_search')).toBe('Searching the web');
    expect(spokenActivity('search_knowledge')).toBe('Searching the knowledge base');
    expect(spokenActivity('chat_memory_write')).toBe('Saving a memory');
  });

  it('falls back to the friendly name', () => {
    expect(spokenActivity('mystery_tool')).toBe('Calling tool');
  });
});

describe('spokenAsk', () => {
  it('names what the assistant wants to do, connector included', () => {
    expect(spokenAsk('jira_create_issue')).toBe('create Jira issue');
    expect(spokenAsk('webex_send_message')).toBe('send WebEx message');
    expect(spokenAsk('outlook_send_mail_preview')).toBe('send Outlook mail');
    expect(spokenAsk('bitbucket_create_pull_request')).toBe('open pull request');
    expect(spokenAsk('code_git_push')).toBe('push');
    expect(spokenAsk('mystery_tool')).toBe('tool');
  });
});

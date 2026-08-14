/**
 * Readable tool names.
 *
 * The rule being pinned is that nothing internal reaches the page: no
 * underscores, no namespace prefix, no Read/Act marker duplicated from the
 * badge beside it.
 */

import { friendlyToolName } from './tool-name';

describe('friendlyToolName', () => {
  it('takes the written title and drops what the grouping already says', () => {
    expect(
      friendlyToolName('confluence_update_blogpost', 'Confluence · Act — Edit a blog post')
    ).toBe('Edit a blog post');
    expect(friendlyToolName('jira_search_issues', 'Jira · Read — Search issues')).toBe(
      'Search issues'
    );
  });

  it('keeps punctuation inside the name itself', () => {
    expect(
      friendlyToolName(
        'confluence_get_page_analytics',
        'Confluence · Read — Get a page’s view analytics'
      )
    ).toBe('Get a page’s view analytics');
  });

  it('falls back to the identifier when there is no title', () => {
    // An operator can see a tool their own grants do not include, so this
    // path is reachable in the tenant-wide view.
    expect(friendlyToolName('confluence_update_blogpost', null)).toBe('Update blogpost');
    expect(friendlyToolName('whoami', null)).toBe('Whoami');
  });

  it('falls back when a title has no separator to split on', () => {
    expect(friendlyToolName('jira_get_issue', 'Some odd title')).toBe('Some odd title');
    expect(friendlyToolName('jira_get_issue', '')).toBe('Get issue');
  });

  it('never shows an underscore or a namespace prefix', () => {
    const names = [
      friendlyToolName('sharepoint_bulk_update_document_metadata', null),
      friendlyToolName('jsm_ops_whos_on_call', null),
      friendlyToolName('outlook_reply_all_message', 'Outlook · Act — Reply to all'),
    ];
    for (const name of names) {
      expect(name).not.toContain('_');
      expect(name).not.toMatch(/^(sharepoint|jsm|outlook|jira|confluence)\b/i);
    }
  });
});

describe('separator handling', () => {
  it('does not split on a hyphen inside a word', () => {
    // "Re-index knowledge" must not become "index knowledge".
    expect(friendlyToolName('knowledge_reindex', 'Knowledge · Act — Re-index knowledge')).toBe(
      'Re-index knowledge'
    );
    expect(friendlyToolName('knowledge_reindex', 'Re-index knowledge')).toBe('Re-index knowledge');
  });
});

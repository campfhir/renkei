/**
 * The act catalog. Two of these assertions catch mistakes that are
 * otherwise completely silent: a typo'd tool name in ACT_OUTCOMES simply
 * never matches, and a mis-declared connector groups a notification under
 * a logo and a preference switch that belong to something else.
 */

import {
  ACT_CATEGORIES,
  ACT_META_KEY,
  ACT_OUTCOMES,
  actResult,
  connectorKeyForTool,
  resolveAct,
} from './index';

describe('the curated catalog', () => {
  it('names tools that connectorKeyForTool recognises', () => {
    // A typo here is invisible at runtime: the entry just never matches and
    // the tool quietly falls through to the generic path forever.
    const unknown = Object.keys(ACT_OUTCOMES).filter((tool) => connectorKeyForTool(tool) === null);
    expect(unknown).toEqual([]);
  });

  it('takes the connector from the catalog rather than declaring one', () => {
    // The descriptor has no connector field on purpose — see its doc. This
    // pins the consequence: grouping always agrees with the tool catalog,
    // so a notification cannot land under a logo and a preference switch
    // that belong to something else.
    expect(resolveAct('confluence_create_page', 'act')?.connector).toBe('atlassian-confluence');
    expect(resolveAct('card_create', 'act')?.connector).toBe('cards');
    expect(resolveAct('jsm_create_request', 'act')?.connector).toBe('jira');
  });

  it('uses only categories the preferences page can show', () => {
    // ACT_CATEGORIES is what the preferences page renders switches from, so
    // a descriptor naming something outside it is a notification nobody
    // could ever turn off.
    const known = new Set<string>(ACT_CATEGORIES);
    const strays = Object.entries(ACT_OUTCOMES)
      .filter(([, d]) => !known.has(d.category))
      .map(([tool]) => tool);
    expect(strays).toEqual([]);
  });

  it('writes labels in the past tense, with no identifier baked in', () => {
    for (const [tool, descriptor] of Object.entries(ACT_OUTCOMES)) {
      // A label carrying its own placeholder would double up when a receipt
      // supplies the real one.
      expect({ tool, label: descriptor.label }).toEqual({
        tool,
        label: expect.not.stringMatching(/\{|\}|%s/),
      });
      expect(descriptor.entity).toBe(descriptor.entity.toLowerCase());
    }
  });
});

describe('resolveAct', () => {
  it('returns null for a read', () => {
    expect(resolveAct('jira_get_issue', 'read')).toBeNull();
  });

  it('treats an unknown kind as an act — the conservative reading', () => {
    // Under-reporting what an agent did is the failure that matters.
    expect(resolveAct('jira_create_issue', null)).not.toBeNull();
  });

  it('uses the curated wording, and appends a receipt id', () => {
    const plain = resolveAct('jira_create_issue', 'act');
    expect(plain?.headline).toBe('Created a Jira issue');
    expect(plain?.category).toBe('created');
    expect(plain?.connector).toBe('jira');
    expect(plain?.curated).toBe(true);

    const withId = resolveAct('jira_create_issue', 'act', {
      [ACT_META_KEY]: { id: 'PROJ-1234', url: 'https://example.atlassian.net/browse/PROJ-1234' },
    });
    expect(withId?.headline).toBe('Created a Jira issue PROJ-1234');
    expect(withId?.id).toBe('PROJ-1234');
    expect(withId?.url).toBe('https://example.atlassian.net/browse/PROJ-1234');
  });

  it('falls through to a plain sentence for an uncurated act', () => {
    const generic = resolveAct('jira_add_attachment', 'act');
    expect(generic?.category).toBe('other');
    expect(generic?.connector).toBe('jira');
    expect(generic?.curated).toBe(false);
    expect(generic?.headline).toBe('Ran jira add attachment');
  });

  it('still takes a receipt from an uncurated tool', () => {
    // Curation improves the wording; it is not a gate on the identifier.
    const found = resolveAct('some_new_tool', 'act', {
      [ACT_META_KEY]: { id: 'X-1', entity: 'widget' },
    });
    expect(found?.headline).toBe('Ran some new tool X-1');
    expect(found?.entity).toBe('widget');
  });

  it('lets a receipt override the curated entity', () => {
    const found = resolveAct('jira_create_issue', 'act', {
      [ACT_META_KEY]: { entity: 'subtask' },
    });
    expect(found?.entity).toBe('subtask');
  });

  it('refuses a link that is not https', () => {
    // A notification's link gets clicked without much thought; a tool must
    // not be able to put an arbitrary scheme behind one.
    for (const url of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', '']) {
      expect(resolveAct('jira_create_issue', 'act', { [ACT_META_KEY]: { url } })?.url).toBeNull();
    }
  });

  it.each([
    ['a string', 'nope'],
    ['an array', ['nope']],
    ['a number', 7],
    ['null', null],
  ])('survives %s where a receipt should be', (_label, raw) => {
    const found = resolveAct('jira_create_issue', 'act', { [ACT_META_KEY]: raw });
    expect(found?.headline).toBe('Created a Jira issue');
    expect(found?.id).toBeNull();
  });

  it('ignores non-string receipt fields', () => {
    const found = resolveAct('jira_create_issue', 'act', {
      [ACT_META_KEY]: { id: 42, url: {}, entity: [] },
    });
    expect(found?.id).toBeNull();
    expect(found?.url).toBeNull();
    expect(found?.entity).toBe('issue');
  });
});

describe('actResult', () => {
  it('puts the receipt where resolveAct reads it', () => {
    const result = actResult('Created PROJ-9.', { id: 'PROJ-9' });
    expect(result.content).toEqual([{ type: 'text', text: 'Created PROJ-9.' }]);
    const found = resolveAct('jira_create_issue', 'act', result._meta);
    expect(found?.headline).toBe('Created a Jira issue PROJ-9');
  });
});

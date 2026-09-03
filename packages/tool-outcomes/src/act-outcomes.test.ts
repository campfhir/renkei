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
  actsByConnector,
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

  it('gives every act a short form for the preferences list', () => {
    // An empty short label renders as a checkbox with no question next to
    // it — unusable, and invisible to a typecheck since '' is a string.
    const missing = Object.entries(ACT_OUTCOMES)
      .filter(([, d]) => d.short.trim() === '')
      .map(([tool]) => tool);
    expect(missing).toEqual([]);
  });

  it('keeps the connector name out of the short form', () => {
    // The short form sits UNDER a connector heading, so repeating the name
    // there is the stutter the two-field split exists to avoid.
    const names = ['Jira', 'Confluence', 'WebEx', 'Zoom', 'SharePoint', 'OneDrive', 'Outlook'];
    const stutters = Object.entries(ACT_OUTCOMES)
      .filter(([, d]) => names.some((name) => d.short.includes(name)))
      .map(([tool]) => tool);
    expect(stutters).toEqual([]);
  });
});

describe('the batch rule', () => {
  it('marks the acts that are themselves batches, and only those', () => {
    const coalesced = Object.entries(ACT_OUTCOMES)
      .filter(([, d]) => d.coalesce === 'run')
      .map(([tool]) => tool)
      .sort();
    // The test is the list on purpose: adding a batch act means saying so
    // here, and flagging a per-item act (whose every call names a
    // different thing worth its own link) fails loudly.
    expect(coalesced).toEqual([
      'jira_bulk_move_sprint_issues',
      'jira_bulk_transition_issues',
      'jira_bulk_update_issues',
      'jira_move_issues',
      'jsm_invite_customers_to_servicedesk',
      'outlook_start_bulk_mail_job',
    ]);
  });

  it('does not call a bulk mail job "sending" — it files, flags and marks; nothing goes out', () => {
    // The wrong category is the wrong switch: someone who turned off
    // "sent an email" alerts would silence archive sweeps, and someone who
    // left it on read "Started sending a batch of email" over a mark-read.
    const found = resolveAct('outlook_start_bulk_mail_job', 'act');
    expect(found?.category).toBe('updated');
    expect(found?.headline).not.toMatch(/send/i);
    expect(ACT_OUTCOMES.outlook_start_bulk_mail_job?.short).not.toMatch(/send/i);
  });

  it('surfaces the rule on the resolved act, absent for a per-call act', () => {
    expect(resolveAct('outlook_start_bulk_mail_job', 'act')?.coalesce).toBe('run');
    expect(resolveAct('jira_bulk_transition_issues', 'act')?.coalesce).toBe('run');
    expect(resolveAct('jira_create_issue', 'act')?.coalesce).toBeNull();
    expect(resolveAct('some_new_tool', 'act')?.coalesce).toBeNull();
  });

  it('keeps the rule when the handler overrides the wording', () => {
    // The receipt says WHICH batch was started; the descriptor still says
    // it is one. Coalescing is keyed by headline downstream, so "marking
    // read" and "archiving" become two tallied rows, not one.
    const found = resolveAct('outlook_start_bulk_mail_job', 'act', {
      [ACT_META_KEY]: { label: 'Started archiving a batch of email' },
    });
    expect(found?.headline).toBe('Started archiving a batch of email');
    expect(found?.coalesce).toBe('run');
    expect(found?.category).toBe('updated');
  });
});

describe('actsByConnector', () => {
  it('groups every curated act under the catalog key for its tool', () => {
    const groups = actsByConnector();
    const flattened = groups.flatMap((group) =>
      group.acts.map((act) => [act.tool, group.connector])
    );
    expect(flattened.length).toBe(Object.keys(ACT_OUTCOMES).length);
    for (const [tool, connector] of flattened) {
      expect({ tool, connector }).toEqual({ tool, connector: connectorKeyForTool(tool) });
    }
  });

  it('orders a connector by category, created first', () => {
    const jira = actsByConnector().find((group) => group.connector === 'jira');
    const ranks = jira?.acts.map((act) => ACT_CATEGORIES.indexOf(act.category)) ?? [];
    expect(ranks.length).toBeGreaterThan(0);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('lists the connectors a person would expect to find', () => {
    // Not an exhaustive pin — new connectors should not break this — but
    // the shared document family is generated, so a broken prefix would
    // silently drop OneDrive from the page entirely.
    const keys = actsByConnector().map((group) => group.connector);
    for (const expected of [
      'jira',
      'atlassian-confluence',
      'microsoft',
      'onedrive',
      'sharepoint',
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it('gives the two document namespaces the same acts under different names', () => {
    const groups = actsByConnector();
    const suffixes = (key: string) =>
      groups
        .find((group) => group.connector === key)
        ?.acts.map((act) => act.tool.replace(/^[a-z]+_/, ''))
        .sort();
    // SharePoint has pages of its own on top, so it is a superset.
    for (const suffix of suffixes('onedrive') ?? []) {
      expect(suffixes('sharepoint')).toContain(suffix);
    }
    expect(suffixes('onedrive')).toContain('delete_document');
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
    // Deliberately uncurated: an upload slot hands back a URL and changes
    // nothing until bytes follow, so it is plumbing rather than news.
    const generic = resolveAct('jira_request_attachment_upload', 'act');
    expect(generic?.category).toBe('other');
    expect(generic?.connector).toBe('jira');
    expect(generic?.curated).toBe(false);
    expect(generic?.headline).toBe('Ran jira request attachment upload');
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

  it('refuses a link whose scheme is not allowlisted', () => {
    // A notification's link gets clicked without much thought; a tool must
    // not be able to put an arbitrary scheme behind one.
    for (const url of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', '']) {
      expect(resolveAct('jira_create_issue', 'act', { [ACT_META_KEY]: { url } })?.url).toBeNull();
    }
  });

  it('accepts the webexteams:// deep link alongside https', () => {
    const found = resolveAct('webex_send_message', 'act', {
      [ACT_META_KEY]: { url: 'webexteams://im?space=bbceb1ad-43f1-3b58-9147-f14bb0c4d154' },
    });
    expect(found?.url).toBe('webexteams://im?space=bbceb1ad-43f1-3b58-9147-f14bb0c4d154');
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

  it('lets a receipt say which of several acts a tool performed', () => {
    // The case the override exists for: one tool, opposite outcomes, and
    // only the handler knows which one the caller asked for.
    const declined = resolveAct('outlook_respond_event', 'act', {
      [ACT_META_KEY]: { label: 'Declined a meeting invitation' },
    });
    expect(declined?.headline).toBe('Declined a meeting invitation');
    // The category still comes from the descriptor — a label override
    // changes the wording, never which switch turns it off.
    expect(declined?.category).toBe('sent');
    expect(declined?.curated).toBe(true);
  });

  it('keeps an overridden label to one bounded line', () => {
    // A handler builds these from its own arguments, which can reach it
    // from a model. A headline is one line and fits on a toast.
    const sneaky = resolveAct('outlook_send_mail', 'act', {
      [ACT_META_KEY]: { label: 'Sent an email\nAND SOMETHING ELSE\r\nentirely' },
    });
    expect(sneaky?.headline).toBe('Sent an email AND SOMETHING ELSE entirely');

    const long = resolveAct('outlook_send_mail', 'act', {
      [ACT_META_KEY]: { label: 'x'.repeat(500) },
    });
    expect(long?.headline.length).toBe(120);
    expect(long?.headline.endsWith('…')).toBe(true);
  });

  it('falls back to the descriptor when the override is unusable', () => {
    for (const label of ['', '   ', 42, null, {}]) {
      expect(resolveAct('outlook_send_mail', 'act', { [ACT_META_KEY]: { label } })?.headline).toBe(
        'Sent an email'
      );
    }
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

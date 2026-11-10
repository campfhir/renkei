/**
 * What the home feed's approval cards say about a proposed batch, and
 * what a decided card leaves behind. These were actionable-cards.spec.ts's
 * rules — the structured issue and email cards, the JSON-safe fallback,
 * never "[object Object]" — which the spec now leaves to this file,
 * keeping one card rendered end to end on the real server.
 */

import {
  executionResultView,
  formatArgValue,
  pauseOutcomeWording,
  proposedActions,
  proposedCallView,
  questionFormFrom,
  relatedExcerpts,
} from './cards.model';

const stored = (tool: string, args: Record<string, unknown>) => ({
  actions: [{ tool, args, reason: 'The agent judged this change necessary.' }],
});

const everyValue = (view: ReturnType<typeof proposedCallView>): string[] =>
  'subtitle' in view
    ? [view.subtitle, view.summary, view.description, ...view.rows.map((row) => row.value)]
    : 'subject' in view
      ? [view.subject, view.body, ...view.rows.map((row) => row.value)]
      : view.rows.map((row) => row.value);

describe('a proposed batch', () => {
  it('lists each action by what it would do and why, in order', () => {
    const actions = proposedActions({
      actions: [
        { tool: 'card_create', args: { title: 'Deploy' }, reason: 'First.' },
        { tool: 'outlook_send_mail', args: { to: ['a@example.com'] }, reason: 'Second.' },
      ],
    });
    expect(actions.map((action) => [action.label, action.reason])).toEqual([
      ['Create', 'First.'],
      ['Send mail', 'Second.'],
    ]);
  });

  it('a card with no readable actions proposes nothing', () => {
    expect(proposedActions(null)).toEqual([]);
    expect(proposedActions({ actions: 'nope' })).toEqual([]);
    expect(proposedActions({})).toEqual([]);
  });
});

describe('a call outside the dedicated cards', () => {
  const [action] = proposedActions(
    stored('card_create', {
      title: 'Deploy the channel',
      summary: 'Both channels are ready.',
      evidence: { channelIds: ['channel-a', 'channel-b'], options: { force: true } },
      count: 3,
      draft: false,
      nothing: null,
    })
  );

  it('falls back to every argument as key: value', () => {
    expect(action.call).toEqual({
      kind: 'fields',
      rows: [
        { label: 'title', value: 'Deploy the channel' },
        { label: 'summary', value: 'Both channels are ready.' },
        {
          label: 'evidence',
          value: '{"channelIds":["channel-a","channel-b"],"options":{"force":true}}',
        },
        { label: 'count', value: '3' },
        { label: 'draft', value: 'false' },
        { label: 'nothing', value: 'null' },
      ],
    });
  });

  it('never reads "[object Object]"', () => {
    expect(everyValue(action.call).join('\n')).not.toContain('[object Object]');
    expect(formatArgValue({ a: 1 })).toBe('{"a":1}');
    expect(formatArgValue(['a', 'b'])).toBe('["a","b"]');
  });
});

describe('a Jira issue call', () => {
  const view = proposedCallView('jira_create_issue', {
    projectKey: 'CIO',
    issueType: 'Project',
    summary: 'Salesforce Incentive-Program Tracking',
    description: 'Evidence: Scott + Dr. Jew/June meeting note.',
    fields: { 'Anti-Kickback Review': 'Required', reviewers: ['scott', 'dr.jew'] },
  });

  it('reads as a project/type header, summary and description', () => {
    expect(view).toMatchObject({
      kind: 'issue',
      subtitle: 'CIO · Project',
      summary: 'Salesforce Incentive-Program Tracking',
      description: 'Evidence: Scott + Dr. Jew/June meeting note.',
    });
  });

  it('gives each extra field its own labelled row, never "[object Object]"', () => {
    if (view.kind !== 'issue') throw new Error('not an issue card');
    expect(view.rows).toEqual(
      expect.arrayContaining([
        { label: 'Anti-Kickback Review', value: 'Required' },
        { label: 'reviewers', value: 'scott, dr.jew' },
      ])
    );
    expect(everyValue(view).join('\n')).not.toContain('[object Object]');
    // The header carries these; they are not repeated as raw rows.
    expect(view.rows.map((row) => row.label)).not.toEqual(
      expect.arrayContaining(['projectKey', 'issueType'])
    );
  });

  it('an update names the issue key when there is no project or type', () => {
    const update = proposedCallView('jira_update_issue', { issueKey: 'OPS-7', summary: 'New' });
    expect(update).toMatchObject({ kind: 'issue', subtitle: 'OPS-7', summary: 'New' });
  });

  it('a JSM request reads the same way', () => {
    expect(proposedCallView('jsm_create_request_confirm', { summary: 'Laptop' }).kind).toBe(
      'issue'
    );
  });

  it('a field that is not text is left out rather than shown wrong', () => {
    const odd = proposedCallView('jira_create_issue', { summary: 42, projectKey: { k: 1 } });
    expect(odd).toMatchObject({ summary: '', subtitle: '' });
  });
});

describe('an Outlook mail call', () => {
  it('reads as To, Cc and Bcc, then subject and body', () => {
    expect(
      proposedCallView('outlook_send_mail', {
        to: ['scott@example.com', 'dr.jew@example.com'],
        cc: ['rebecca@example.com'],
        bcc: ['audit@example.com'],
        subject: 'Weekly incentive-tracking digest',
        body: 'Salesforce remains the preferred long-term option.',
      })
    ).toEqual({
      kind: 'email',
      rows: [
        { label: 'To', value: 'scott@example.com, dr.jew@example.com' },
        { label: 'Cc', value: 'rebecca@example.com' },
        { label: 'Bcc', value: 'audit@example.com' },
      ],
      subject: 'Weekly incentive-tracking digest',
      body: 'Salesforce remains the preferred long-term option.',
    });
  });

  it('a reply with only extra recipients says the rest fill themselves in', () => {
    const view = proposedCallView('outlook_reply_all_message', {
      additionalTo: ['new@example.com'],
      comment: 'Looping in New.',
    });
    expect(view).toEqual({
      kind: 'email',
      rows: [{ label: 'Also to', value: '(auto-populated) new@example.com' }],
      subject: '',
      body: 'Looping in New.',
    });
  });

  it('leaves out recipients that are not addresses, and empty lines', () => {
    const view = proposedCallView('outlook_forward_message', { to: [{ name: 'x' }, 'ok@x.test'] });
    expect(view).toEqual({
      kind: 'email',
      rows: [{ label: 'To', value: 'ok@x.test' }],
      subject: '',
      body: '',
    });
  });
});

describe('a decided card', () => {
  it('an accepted approval says so, with the person’s note when they left one', () => {
    expect(pauseOutcomeWording('approval', 'approved', {})).toBe(
      'You accepted — the actions were carried out and the run continued.'
    );
    expect(pauseOutcomeWording('approval', 'approved', { comment: 'use OPS' })).toBe(
      'You accepted: use OPS'
    );
  });

  it('a declined approval says so, with the note', () => {
    expect(pauseOutcomeWording('approval', 'declined', null)).toBe('You declined.');
    expect(pauseOutcomeWording('approval', 'declined', { comment: 'not now' })).toBe(
      'You declined: not now'
    );
  });

  it('an approval nobody decided says whether the run ended or the wait ran out', () => {
    expect(pauseOutcomeWording('approval', 'expired', { reason: 'run-ended' })).toBe(
      'The run ended before anyone decided.'
    );
    expect(pauseOutcomeWording('approval', 'expired', { reason: 'agent-disabled' })).toBe(
      'The run ended before anyone decided.'
    );
    expect(pauseOutcomeWording('approval', 'expired', {})).toBe(
      'Nobody decided in time — none of the actions were made.'
    );
  });

  it('a question reads answered, ended, or unanswered', () => {
    expect(pauseOutcomeWording('question', 'answered', {})).toBe(
      'You answered — the run continued.'
    );
    expect(pauseOutcomeWording('question', 'expired', { reason: 'run-ended' })).toBe(
      'The run ended before anyone answered.'
    );
    expect(pauseOutcomeWording('question', 'expired', {})).toBe(
      'Nobody answered in time — the run treated it as unanswered.'
    );
  });
});

describe('an executed card', () => {
  it('a created issue links to it', () => {
    expect(
      executionResultView({ issueKey: 'OPS-1', url: 'https://x.atlassian.net/browse/OPS-1' }, false)
    ).toEqual({ kind: 'created', issueKey: 'OPS-1', url: 'https://x.atlassian.net/browse/OPS-1' });
  });

  it('a failure says why, never "[object Object]"', () => {
    expect(executionResultView({ error: 'Jira said no' }, true)).toEqual({
      kind: 'failed',
      message: 'Jira said no',
    });
    expect(executionResultView({}, true)).toEqual({ kind: 'failed', message: 'unknown error' });
    expect(executionResultView({ error: { code: 403 } }, true)).toEqual({
      kind: 'failed',
      message: '{"code":403}',
    });
  });

  it('anything else says nothing', () => {
    expect(executionResultView(null, false)).toBeNull();
    expect(executionResultView({ ok: true }, false)).toBeNull();
  });
});

describe('the rest of a card', () => {
  it('lists similar prior discussion, skipping entries it cannot read', () => {
    expect(
      relatedExcerpts({ related: [{ excerpt: 'Last week we…' }, 'junk', { excerpt: null }] })
    ).toEqual(['Last week we…', '']);
    expect(relatedExcerpts({})).toEqual([]);
    expect(relatedExcerpts(null)).toEqual([]);
  });

  it('a question card with no form asks with no fields', () => {
    expect(questionFormFrom(null)).toEqual([]);
    expect(questionFormFrom({ form: 'nope' })).toEqual([]);
  });
});

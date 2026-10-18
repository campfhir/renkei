import {
  MAX_STAGED_ACTIONS,
  batchReportForAgent,
  parseStagedActions,
  parseStoredActions,
  parseStoredResults,
} from './action-batch';

const stageable = new Set(['jira_create_issue', 'jira_add_comment']);

describe('parseStagedActions', () => {
  it('reads a batch in order, defaulting missing args to {}', () => {
    const parsed = parseStagedActions(
      {
        summary: ' File it and say so ',
        actions: [
          { tool: 'jira_create_issue', args: { summary: 'Login broken' }, reason: 'No ticket yet' },
          { tool: 'jira_add_comment', reason: 'Tell the reporter' },
        ],
      },
      stageable
    );
    expect(parsed).toEqual({
      summary: 'File it and say so',
      actions: [
        { tool: 'jira_create_issue', args: { summary: 'Login broken' }, reason: 'No ticket yet' },
        { tool: 'jira_add_comment', args: {}, reason: 'Tell the reporter' },
      ],
    });
  });

  it('refuses a tool that is not stageable, naming the ones that are', () => {
    const parsed = parseStagedActions(
      { summary: 's', actions: [{ tool: 'jira_search_issues', args: {}, reason: 'r' }] },
      stageable
    );
    expect(parsed).toEqual({
      error: expect.stringContaining('jira_create_issue, jira_add_comment'),
    });
  });

  it('needs a summary, actions, reasons and object args, and caps the batch', () => {
    expect(parseStagedActions({ actions: [] }, stageable)).toHaveProperty('error');
    expect(parseStagedActions({ summary: 's', actions: [] }, stageable)).toHaveProperty('error');
    expect(
      parseStagedActions(
        { summary: 's', actions: [{ tool: 'jira_add_comment', args: {}, reason: ' ' }] },
        stageable
      )
    ).toHaveProperty('error');
    expect(
      parseStagedActions(
        { summary: 's', actions: [{ tool: 'jira_add_comment', args: [1], reason: 'r' }] },
        stageable
      )
    ).toHaveProperty('error');
    const many = Array.from({ length: MAX_STAGED_ACTIONS + 1 }, () => ({
      tool: 'jira_add_comment',
      args: {},
      reason: 'r',
    }));
    expect(parseStagedActions({ summary: 's', actions: many }, stageable)).toHaveProperty('error');
  });
});

describe('stored batches', () => {
  it('drops malformed entries', () => {
    expect(parseStoredActions([{ tool: 'a', args: {}, reason: 'r' }, { tool: 1 }, null])).toEqual([
      { tool: 'a', args: {}, reason: 'r' },
    ]);
    expect(
      parseStoredResults([
        { tool: 'a', outcome: 'succeeded', text: 'ok', durationMs: 3 },
        { tool: 'a', outcome: 'maybe', text: 'x', durationMs: 1 },
      ])
    ).toEqual([{ tool: 'a', outcome: 'succeeded', text: 'ok', durationMs: 3 }]);
  });
});

describe('batchReportForAgent', () => {
  const actions = [
    { tool: 'jira_create_issue', args: {}, reason: 'r' },
    { tool: 'jira_add_comment', args: {}, reason: 'r' },
  ];

  it('reports each outcome, fencing what the tool said', () => {
    const report = batchReportForAgent({
      status: 'completed',
      actions,
      results: [
        { tool: 'jira_create_issue', outcome: 'failed', text: 'Project not found', durationMs: 5 },
        {
          tool: 'jira_add_comment',
          outcome: 'skipped',
          text: 'An earlier action failed.',
          durationMs: 0,
        },
      ],
      acceptedBy: 'auto',
      comment: null,
    });
    expect(report).toContain('accepted automatically');
    expect(report).toContain('stopped at the first failure');
    expect(report).toContain('1. jira_create_issue: failed. Project not found');
    expect(report).toContain('2. jira_add_comment: skipped.');
  });

  it('fences a succeeded result as untrusted data', () => {
    const report = batchReportForAgent({
      status: 'completed',
      actions: actions.slice(0, 1),
      results: [{ tool: 'jira_create_issue', outcome: 'succeeded', text: 'PROJ-9', durationMs: 5 }],
      acceptedBy: 'person',
      comment: 'Looks right',
    });
    expect(report).toContain('<untrusted source="tool:jira_create_issue">');
    expect(report).toContain('Their comment: Looks right');
  });

  it('says plainly when nothing ran', () => {
    const base = { actions, results: [], acceptedBy: null, comment: 'Not this one' } as const;
    expect(batchReportForAgent({ ...base, status: 'declined' })).toContain('declined');
    expect(batchReportForAgent({ ...base, status: 'expired' })).toContain('timed out');
  });
});

import {
  ACTION_REPORT_CHARS,
  ACTION_RESULT_CHARS,
  MAX_STAGED_ACTIONS,
  batchReportForAgent,
  clipActionResult,
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

  it('reads actions and args that arrive as JSON text, and says when actions is not a list', () => {
    const parsed = parseStagedActions(
      {
        summary: 's',
        actions: JSON.stringify([
          { tool: 'jira_add_comment', args: JSON.stringify({ issueKey: 'CIO-1' }), reason: 'r' },
        ]),
      },
      stageable
    );
    expect(parsed).toEqual({
      summary: 's',
      actions: [{ tool: 'jira_add_comment', args: { issueKey: 'CIO-1' }, reason: 'r' }],
    });
    expect(parseStagedActions({ summary: 's', actions: 'oops' }, stageable)).toEqual({
      error: expect.stringContaining('array'),
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

  it('hands back a page-sized result whole', () => {
    const page = `${'AIG.n row. '.repeat(800)}AIG.14 Filler Status Code`;
    expect(clipActionResult(page, ACTION_RESULT_CHARS)).toBe(page);
    const report = batchReportForAgent({
      status: 'completed',
      actions: actions.slice(0, 1),
      results: [{ tool: 'jira_create_issue', outcome: 'succeeded', text: page, durationMs: 5 }],
      acceptedBy: 'auto',
      comment: null,
    });
    expect(report).toContain('AIG.14 Filler Status Code');
    expect(report).not.toContain('truncated');
  });

  it('shares the report budget across a batch too big to return whole, and says so', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      tool: 'jira_add_comment',
      args: {},
      reason: `r${index}`,
    }));
    const full = 'x'.repeat(ACTION_RESULT_CHARS);
    const report = batchReportForAgent({
      status: 'completed',
      actions: many,
      results: many.map((action) => ({
        tool: action.tool,
        outcome: 'succeeded' as const,
        text: full,
        durationMs: 1,
      })),
      acceptedBy: 'auto',
      comment: null,
    });
    const share = Math.floor(ACTION_REPORT_CHARS / 5);
    expect(report.match(/truncated by the action executor/g)).toHaveLength(5);
    expect(report).toContain(`${ACTION_RESULT_CHARS - share} more characters were not kept`);
    expect(report.length).toBeLessThan(ACTION_REPORT_CHARS + 5_000);
  });

  it('says plainly when nothing ran', () => {
    const base = { actions, results: [], acceptedBy: null, comment: 'Not this one' } as const;
    expect(batchReportForAgent({ ...base, status: 'declined' })).toContain('declined');
    expect(batchReportForAgent({ ...base, status: 'expired' })).toContain('timed out');
  });
});

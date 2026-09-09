import { CURRENT_STEPS_VERSION } from '@renkei/agents';
import { labelStepUsage } from './step-usage-labels';
import {
  renderAgentUsageText,
  renderAgentsUsageText,
  renderRunUsageMarkdown,
  runTokenLine,
  tokenFigure,
} from './usage-text';
import type { UsageBuckets } from './agent-usage';

const buckets = (overrides: Partial<UsageBuckets> = {}): UsageBuckets => ({
  today: 0,
  yesterday: 0,
  week: 0,
  month: 0,
  quarter: 0,
  year: 0,
  allTime: 0,
  ...overrides,
});

const STEP_A = '11111111-1111-4111-8111-111111111111';
const STEP_B = '22222222-2222-4222-8222-222222222222';
const doc = {
  version: CURRENT_STEPS_VERSION,
  steps: [
    {
      id: STEP_A,
      name: 'Read the inbox',
      instruction: [{ t: 'text', v: 'Look.' }],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    },
    {
      id: STEP_B,
      name: 'Reply',
      instruction: [{ t: 'text', v: 'Answer.' }],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    },
  ],
};

describe('tokenFigure', () => {
  it('names the cached portion and cache writes only when there are any', () => {
    expect(tokenFigure({ input: 12_400, output: 900, cacheRead: 0, cacheWrite: 0 })).toBe(
      '12,400 in · 900 out'
    );
    expect(tokenFigure({ input: 12_400, output: 900, cacheRead: 3_100, cacheWrite: 200 })).toBe(
      '12,400 in (3,100 cached) · 900 out · 200 cache writes'
    );
  });

  it('runTokenLine adds the model-call count, singular when one', () => {
    expect(runTokenLine({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1 })).toBe(
      'tokens: 10 in · 1 out · 1 model call'
    );
  });
});

describe('renderAgentUsageText', () => {
  const text = renderAgentUsageText({
    agentName: 'Triage',
    agentId: 'agent-1',
    period: 'month',
    tokens: {
      input: buckets({ today: 100, month: 5_000, allTime: 9_000 }),
      output: buckets({ today: 10, month: 400, allTime: 800 }),
      cacheRead: buckets({ month: 1_000, allTime: 1_500 }),
      cacheWrite: buckets({ allTime: 30 }),
    },
    byModel: [
      {
        provider: 'openai',
        model: 'gpt-small',
        input: buckets({ month: 1_000 }),
        output: buckets({ month: 100 }),
        cacheRead: buckets(),
        cacheWrite: buckets(),
      },
      {
        provider: 'anthropic',
        model: 'claude-big',
        input: buckets({ month: 4_000 }),
        output: buckets({ month: 300 }),
        cacheRead: buckets({ month: 1_000 }),
        cacheWrite: buckets(),
      },
      {
        provider: null,
        model: null,
        input: buckets({ allTime: 7 }),
        output: buckets(),
        cacheRead: buckets(),
        cacheWrite: buckets(),
      },
    ],
    bySteps: labelStepUsage(doc, [
      // The reply step twice, once per model — summed into one line.
      {
        stepId: STEP_B,
        provider: 'anthropic',
        model: 'claude-big',
        calls: buckets({ month: 2 }),
        input: buckets({ month: 2_000 }),
        output: buckets({ month: 150 }),
        cacheRead: buckets({ month: 500 }),
        cacheWrite: buckets(),
      },
      {
        stepId: STEP_B,
        provider: 'openai',
        model: 'gpt-small',
        calls: buckets({ month: 1 }),
        input: buckets({ month: 1_000 }),
        output: buckets({ month: 100 }),
        cacheRead: buckets(),
        cacheWrite: buckets(),
      },
      {
        stepId: null,
        provider: 'anthropic',
        model: 'claude-big',
        calls: buckets({ month: 1 }),
        input: buckets({ month: 500 }),
        output: buckets({ month: 50 }),
        cacheRead: buckets(),
        cacheWrite: buckets(),
      },
      {
        stepId: '33333333-3333-4333-8333-333333333333',
        provider: 'anthropic',
        model: 'claude-big',
        calls: buckets({ month: 1 }),
        input: buckets({ month: 300 }),
        output: buckets({ month: 20 }),
        cacheRead: buckets(),
        cacheWrite: buckets(),
      },
      {
        stepId: STEP_A,
        provider: 'anthropic',
        model: 'claude-big',
        calls: buckets({ month: 3 }),
        input: buckets({ month: 1_200 }),
        output: buckets({ month: 80 }),
        cacheRead: buckets({ month: 500 }),
        cacheWrite: buckets(),
      },
    ]),
    tools: [
      {
        tool: 'outlook_send_mail',
        connector: 'outlook',
        calls: 3,
        errors: 0,
        medianMs: 0,
        p95Ms: 0,
      },
      {
        tool: 'jira_search_issues',
        connector: 'jira',
        calls: 12,
        errors: 1,
        medianMs: 300,
        p95Ms: 1200,
      },
      { tool: 'jira_get_issue', connector: 'jira', calls: 4, errors: 0, medianMs: 90, p95Ms: 110 },
      { tool: 'resolve_time', connector: null, calls: 1, errors: 0, medianMs: 0, p95Ms: 0 },
    ],
    toolWindowDays: 30,
  });

  it('lists every period at once, the pills without a round trip each', () => {
    expect(text).toContain(
      [
        'Tokens by period (cached = the portion of the input served from cache):',
        '- Today: 100 in · 10 out',
        '- Yesterday: 0 in · 0 out',
        '- This week: 0 in · 0 out',
        '- This month: 5,000 in (1,000 cached) · 400 out',
        '- This quarter: 0 in · 0 out',
        '- This year: 0 in · 0 out',
        '- All time: 9,000 in (1,500 cached) · 800 out · 30 cache writes',
      ].join('\n')
    );
  });

  it('splits the chosen period by model, largest first, models with nothing in it left out', () => {
    expect(text).toContain(
      [
        'By model · this month:',
        '- claude-big: 4,000 in (1,000 cached) · 300 out',
        '- gpt-small · openai: 1,000 in · 100 out',
        '',
      ].join('\n')
    );
    expect(text).not.toContain('Model not recorded');
  });

  it('splits it by step in definition order, summed across models, unnamed rows last', () => {
    expect(text).toContain(
      [
        'By step · this month:',
        '- 1. Read the inbox: 1,200 in (500 cached) · 80 out · 3 model calls',
        '- 2. Reply: 3,000 in (500 cached) · 250 out · 3 model calls',
        '- A step since removed: 300 in · 20 out · 1 model call',
        '- Outside any step (optimizer): 500 in · 50 out · 1 model call',
        '',
      ].join('\n')
    );
  });

  it('groups tool calls by connector, busiest first, with failures and latency where known', () => {
    expect(text).toContain(
      [
        'Tool calls, last 30 days: 20 (1 failed)',
        'jira:',
        '- jira_search_issues: 12 calls · 1 failed · median 300ms, p95 1.2s',
        '- jira_get_issue: 4 calls · median 90ms, p95 110ms',
        'outlook:',
        '- outlook_send_mail: 3 calls',
        'other:',
        '- resolve_time: 1 call',
      ].join('\n')
    );
  });

  it('says so when a period has nothing in it', () => {
    const empty = renderAgentUsageText({
      agentName: 'Triage',
      agentId: 'agent-1',
      period: 'today',
      tokens: { input: buckets(), output: buckets(), cacheRead: buckets(), cacheWrite: buckets() },
      byModel: [],
      bySteps: [],
      tools: [],
      toolWindowDays: 30,
    });
    expect(empty).toContain('By model · today:\n- no tokens today');
    expect(empty).toContain('By step · today:\n- no tokens today');
    expect(empty).toContain('Tool calls, last 30 days: 0\n- none');
  });
});

describe('renderAgentsUsageText', () => {
  it('totals the roster and orders it by spend, naming who shared what', () => {
    const text = renderAgentsUsageText('week', [
      {
        agentId: 'a',
        name: 'Quiet',
        tokens: {
          input: buckets(),
          output: buckets(),
          cacheRead: buckets(),
          cacheWrite: buckets(),
        },
      },
      {
        agentId: 'b',
        name: 'Busy',
        sharedBy: 'Owner',
        tokens: {
          input: buckets({ week: 900 }),
          output: buckets({ week: 90 }),
          cacheRead: buckets({ week: 300 }),
          cacheWrite: buckets(),
        },
      },
    ]);
    expect(text).toBe(
      [
        'Token usage of 2 agent(s) · this week: 900 in (300 cached) · 90 out',
        '',
        '- Busy (shared by Owner): 900 in (300 cached) · 90 out',
        '  agentId: b',
        '- Quiet: 0 in · 0 out',
        '  agentId: a',
        '',
        'Give an agentId for its usage by model and by step, and its tool calls.',
      ].join('\n')
    );
  });
});

describe('renderRunUsageMarkdown', () => {
  it('says when the ledger has nothing for the run', () => {
    expect(renderRunUsageMarkdown([])).toBe(
      '## Token usage\n\nNo model calls recorded for this run.'
    );
  });

  it('totals the run and splits it by step in snapshot order and by model by spend', () => {
    const rows = labelStepUsage(doc, [
      {
        stepId: STEP_B,
        provider: 'anthropic',
        model: 'claude-big',
        input: 2_000,
        output: 150,
        cacheRead: 500,
        cacheWrite: 0,
        calls: 2,
      },
      {
        stepId: STEP_A,
        provider: 'openai',
        model: 'gpt-small',
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
      },
      {
        stepId: STEP_A,
        provider: 'anthropic',
        model: 'claude-big',
        input: 1_000,
        output: 80,
        cacheRead: 400,
        cacheWrite: 20,
        calls: 1,
      },
    ]);
    expect(renderRunUsageMarkdown(rows)).toBe(
      [
        '## Token usage',
        '',
        '- Total: 3,100 in (900 cached) · 240 out · 20 cache writes · 4 model calls',
        '',
        '### By step',
        '',
        '- 1. Read the inbox: 1,100 in (400 cached) · 90 out · 20 cache writes · 2 model calls',
        '- 2. Reply: 2,000 in (500 cached) · 150 out · 2 model calls',
        '',
        '### By model',
        '',
        '- claude-big: 3,000 in (900 cached) · 230 out · 20 cache writes',
        '- gpt-small · openai: 100 in · 10 out',
      ].join('\n')
    );
  });
});

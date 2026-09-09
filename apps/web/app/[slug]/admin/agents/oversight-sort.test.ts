import { sortAgentRows, type OversightTallies } from './oversight-sort';
import type { TokenUsage, UsageBuckets } from '@/lib/agents/agent-usage';

function buckets(month: number, allTime = month): UsageBuckets {
  return { today: 0, yesterday: 0, week: 0, month, quarter: month, year: month, allTime };
}

function tokens(input: UsageBuckets, output: UsageBuckets = buckets(0)): TokenUsage {
  return { input, output, cacheRead: buckets(0), cacheWrite: buckets(0) };
}

const agents = [
  { id: 'b', name: 'Beta' },
  { id: 'a', name: 'alpha' },
  { id: 'c', name: 'Gamma' },
];

const tallies: OversightTallies = {
  runsByAgent: { a: buckets(5), b: buckets(9), c: buckets(5) },
  failuresByAgent: { a: buckets(1) },
  tokensByAgent: {
    a: tokens(buckets(100, 9_000)),
    b: tokens(buckets(3_000, 3_000)),
    c: tokens(buckets(0), buckets(40)),
  },
};

describe('sortAgentRows', () => {
  it('orders by name, case-insensitively, when asked for name', () => {
    expect(sortAgentRows(agents, 'name', 'month', tallies).map((agent) => agent.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('puts the largest tally first and breaks ties by name', () => {
    expect(sortAgentRows(agents, 'runs', 'month', tallies).map((agent) => agent.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('reads the tally for the period in view', () => {
    expect(sortAgentRows(agents, 'tokensIn', 'month', tallies).map((agent) => agent.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(sortAgentRows(agents, 'tokensIn', 'allTime', tallies).map((agent) => agent.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('treats an agent with no ledger rows as zero', () => {
    expect(sortAgentRows(agents, 'tokensOut', 'month', tallies).map((agent) => agent.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

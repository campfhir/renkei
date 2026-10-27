import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-d${String(n).padStart(11, '0')}`;
const DAY_MS = 86_400_000;
/**
 * Calendar buckets are relative to today, so these fixtures are too: one
 * instant taken when the module loads, and rows that many days before it.
 * (A run that straddles UTC midnight could see the two stores cut on
 * different days; the suite takes seconds.)
 */
const NOW = Date.now();
const daysAgo = (days: number, minutes = 0) =>
  new Date(NOW - days * DAY_MS - minutes * 60_000).toISOString();

const agents = [
  { id: id(1), owner_subject: 'ann', name: 'beta' },
  { id: id(2), owner_subject: 'ann', name: 'Alpha' },
  { id: id(3), owner_subject: 'bob', name: 'Gamma' },
];

function call(
  n: number,
  agent: number | null,
  daysBack: number,
  tokens: { input: number; output: number; read?: number | null; write?: number | null },
  extra: Record<string, unknown> = {}
) {
  return {
    id: id(n),
    subject: 'ann',
    purpose: agent === null ? 'chat' : 'agent_run',
    agent_id: agent === null ? null : id(agent),
    provider: 'anthropic',
    model: 'big',
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_read_input_tokens: tokens.read ?? null,
    cache_write_input_tokens: tokens.write ?? null,
    created_at: daysAgo(daysBack),
    ...extra,
  };
}

const ledger = {
  agents,
  agent_runs: [
    { id: id(41), agent_id: id(1), owner_subject: 'ann', trigger_kind: 'manual' },
    { id: id(42), agent_id: id(1), owner_subject: 'ann', trigger_kind: 'manual' },
  ],
  llm_calls: [
    call(11, 1, 0, { input: 10, output: 1, read: 5 }, { run_id: id(41) }),
    call(12, 1, 1, { input: 20, output: 2, write: 7 }, { run_id: id(41), model: 'small' }),
    call(13, 1, 8, { input: 40, output: 4 }, { run_id: id(42), provider: null, model: null }),
    call(14, 1, 45, { input: 80, output: 8 }),
    call(15, 2, 120, { input: 160, output: 16 }, { model: 'small' }),
    call(16, 2, 400, { input: 320, output: 32 }),
    call(17, null, 0, { input: 1000, output: 100 }),
    call(18, 3, 2, { input: 5, output: 5 }, { provider: 'openai', model: 'gpt' }),
  ],
};

function tool(n: number, agent: number, name: string, ms: number, daysBack: number, status = 'ok') {
  return {
    id: id(n),
    agent_id: id(agent),
    subject: 'ann',
    tool: name,
    status,
    duration_ms: ms,
    started_at: daysAgo(daysBack),
    ended_at: daysAgo(daysBack),
  };
}

const tools = {
  agents,
  tool_calls: [
    tool(21, 1, 'jira_search', 100, 0),
    tool(22, 1, 'jira_search', 300, 1, 'error'),
    tool(23, 1, 'jira_search', 200, 2),
    tool(24, 1, 'jira_search', 400, 3),
    tool(25, 2, 'mail_send', 50, 1),
    tool(26, 2, 'calendar_list', 70, 1),
    tool(27, 1, 'calendar_list', 90, 2, 'denied'),
    tool(28, 1, 'old_tool', 10, 60),
    tool(29, 3, 'jira_search', 1, 0),
  ],
  llm_calls: ledger.llm_calls,
};

function log(n: number, agent: number, daysBack: number, status: string) {
  return {
    run_id: id(n),
    agent_id: id(agent),
    owner_subject: 'ann',
    trigger_kind: 'manual',
    status,
    created_at: daysAgo(daysBack),
  };
}

const runLog = {
  agents,
  agent_run_log: [
    log(31, 1, 0, 'succeeded'),
    log(32, 1, 0, 'failed'),
    log(33, 1, 1, 'failed'),
    log(34, 1, 10, 'succeeded'),
    log(35, 1, 100, 'failed'),
    log(36, 2, 0, 'succeeded'),
    log(37, 2, 500, 'succeeded'),
  ],
};

export const agentUsageScenarios: Scenario<DataStore>[] = [
  {
    method: 'agentUsage.tokenBuckets',
    name: 'one agent, several summed, everyone, and none',
    fixture: ledger,
    run: async (store) => [
      await store.agentUsage.tokenBuckets([id(1)]),
      await store.agentUsage.tokenBuckets([id(1), id(2)]),
      await store.agentUsage.tokenBuckets(null),
      await store.agentUsage.tokenBuckets([]),
      await store.agentUsage.tokenBuckets([id(9)]),
    ],
  },
  {
    method: 'agentUsage.tokenBucketsByAgent',
    name: 'every agent with ledger rows, by id; chat spend left out',
    fixture: ledger,
    run: async (store) => store.agentUsage.tokenBucketsByAgent(),
  },
  {
    method: 'agentUsage.tokenBucketsByModel',
    name: 'largest spend first, the unrecorded model as one row',
    fixture: ledger,
    run: async (store) => [
      await store.agentUsage.tokenBucketsByModel([id(1)]),
      await store.agentUsage.tokenBucketsByModel(null),
      await store.agentUsage.tokenBucketsByModel([]),
    ],
  },
  {
    method: 'agentUsage.tokenBucketsByModel',
    name: 'equal spend ties by provider then model, nulls last',
    fixture: {
      agents,
      llm_calls: [
        call(11, 1, 0, { input: 5, output: 5 }, { provider: 'b', model: 'x' }),
        call(12, 1, 0, { input: 5, output: 5 }, { provider: 'a', model: 'y' }),
        call(13, 1, 0, { input: 5, output: 5 }, { provider: 'a', model: null }),
        call(14, 1, 0, { input: 5, output: 5 }, { provider: null, model: null }),
        call(15, 1, 0, { input: 5, output: 5 }, { provider: 'a', model: 'x' }),
      ],
    },
    run: async (store) =>
      (await store.agentUsage.tokenBucketsByModel([id(1)])).map((row) => [row.provider, row.model]),
  },
  {
    method: 'agentUsage.toolUsage',
    name: 'per tool in the window, most calls first, percentiles',
    fixture: tools,
    run: async (store) => [
      await store.agentUsage.toolUsage([id(1)], 30),
      await store.agentUsage.toolUsage([id(1), id(2)], 30),
      await store.agentUsage.toolUsage([id(1)], 90),
      await store.agentUsage.toolUsage([], 30),
    ],
  },
  {
    method: 'agentUsage.usageSummaries',
    name: 'per agent by name, zero when idle; one owner or everyone',
    fixture: tools,
    run: async (store) => [
      await store.agentUsage.usageSummaries('ann', 30),
      await store.agentUsage.usageSummaries(null, 7),
      await store.agentUsage.usageSummaries('nobody', 30),
    ],
  },
  {
    method: 'agentUsage.tokenTrend',
    name: 'per day in the zone, from the window start',
    fixture: ledger,
    run: async (store) => [
      (await store.agentUsage.tokenTrend([id(1)], 30, 'UTC')).length,
      (await store.agentUsage.tokenTrend([id(1), id(2)], 3, 'UTC')).map((p) => [
        p.inputTokens,
        p.outputTokens,
      ]),
      (await store.agentUsage.tokenTrend([id(1)], 1, 'America/Los_Angeles')).length <= 2,
      await store.agentUsage.tokenTrend([], 30, 'UTC'),
    ],
  },
  {
    method: 'agentUsage.tokensByRun',
    name: 'totals per run with rows, by run id',
    fixture: ledger,
    run: async (store) => [
      await store.agentUsage.tokensByRun([id(41), id(42), id(99)]),
      await store.agentUsage.tokensByRun([]),
    ],
  },
  {
    method: 'agentUsage.runTokensByModel',
    name: "one run's spend per model, largest first",
    fixture: ledger,
    run: async (store) => [
      await store.agentUsage.runTokensByModel(id(41)),
      await store.agentUsage.runTokensByModel(id(99)),
    ],
  },
  {
    method: 'agentUsage.invocationCounts',
    name: "one agent's run buckets and the org's runs today",
    fixture: runLog,
    run: async (store) => [
      await store.agentUsage.invocationCounts(id(1)),
      await store.agentUsage.invocationCounts(id(3)),
    ],
  },
  {
    method: 'agentUsage.runLogBuckets',
    name: 'totals and per agent, failures apart',
    fixture: runLog,
    run: async (store) => store.agentUsage.runLogBuckets(),
  },
  {
    method: 'agentUsage.runLogBuckets',
    name: 'an empty log is all zeros',
    run: async (store) => store.agentUsage.runLogBuckets(),
  },
  {
    method: 'agentUsage.pruneLedgersBefore',
    name: 'each ledger bounded on its own, oldest first, ties by key; newer rows kept',
    fixture: {
      agents,
      agent_run_log: [
        {
          run_id: id(301),
          agent_id: id(1),
          owner_subject: 'ann',
          trigger_kind: 'manual',
          created_at: '2025-01-03T00:00:00.000Z',
        },
        {
          run_id: id(302),
          agent_id: id(1),
          owner_subject: 'ann',
          trigger_kind: 'manual',
          created_at: '2025-01-01T00:00:00.000Z',
        },
        {
          run_id: id(303),
          agent_id: id(3),
          owner_subject: 'bob',
          trigger_kind: 'manual',
          created_at: '2025-01-01T00:00:00.000Z',
        },
        {
          run_id: id(304),
          agent_id: id(1),
          owner_subject: 'ann',
          trigger_kind: 'manual',
          created_at: '2025-06-01T00:00:00.000Z',
        },
      ],
      llm_calls: [
        { id: id(311), subject: 'ann', purpose: 'chat', created_at: '2025-01-02T00:00:00.000Z' },
        { id: id(312), subject: 'bob', purpose: 'chat', created_at: '2025-07-02T00:00:00.000Z' },
      ],
      voice_usage: [
        { id: id(321), subject: 'ann', kind: 'transcribe', created_at: '2025-01-02T00:00:00.000Z' },
        { id: id(322), subject: 'ann', kind: 'transcribe', created_at: '2025-01-01T00:00:00.000Z' },
        { id: id(323), subject: 'ann', kind: 'transcribe', created_at: '2025-01-05T00:00:00.000Z' },
      ],
      image_usage: [
        { id: id(331), subject: 'ann', surface: 'chat', created_at: '2025-01-02T00:00:00.000Z' },
      ],
      document_usage: [],
    },
    run: async (store) => {
      const cutoff = new Date('2025-03-01T00:00:00.000Z');
      const first = await store.agentUsage.pruneLedgersBefore(cutoff, 1);
      const runsLeft = (await store.agentUsage.runLogBuckets()).byAgent.map((a) => a.agentId);
      const second = await store.agentUsage.pruneLedgersBefore(cutoff, 2);
      const third = await store.agentUsage.pruneLedgersBefore(cutoff, 2);
      return [first, runsLeft, second, third];
    },
  },
];

import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-b${String(n).padStart(11, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const refusal = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : 'threw';

function run(
  n: number,
  agent: number,
  owner: string,
  minute: number,
  extra: Record<string, unknown> = {}
) {
  return {
    id: id(n),
    agent_id: id(agent),
    owner_subject: owner,
    trigger_kind: 'manual',
    created_at: at(minute),
    ...extra,
  };
}

const agents = [
  { id: id(1), owner_subject: 'ann', name: 'Ann agent' },
  { id: id(2), owner_subject: 'bob', name: 'Bob agent' },
];

const fixture = {
  agents,
  agent_runs: [
    run(11, 1, 'ann', 1, {
      status: 'succeeded',
      initial_state: { subject: 'Quarterly Report', count: 2 },
      started_at: at(1),
      finished_at: at(2),
      resume_guidance: 'try harder',
    }),
    run(12, 1, 'ann', 3, {
      status: 'failed',
      error: 'Jira said 500_ok',
      error_kind: 'tool',
      initial_state: { subject: 'Weekly report' },
      resume_count: 1,
      resumed_at: at(4),
      active_ms: '1500',
      definition_snapshot: { instructions: 'x', tools: [] },
    }),
    run(13, 1, 'ann', 3, { status: 'waiting', trigger_kind: 'schedule', waiting_until: at(50) }),
    run(14, 1, 'grantee', 5, { status: 'queued', trigger_kind: 'event' }),
    run(15, 2, 'bob', 6, { status: 'running' }),
  ],
  agent_run_steps: [
    {
      id: id(21),
      run_id: id(12),
      step_id: 'turn',
      step_index: 0,
      attempt: 2,
      status: 'failed',
      detail: { llmSummary: 'two' },
    },
    {
      id: id(22),
      run_id: id(12),
      step_id: 'turn',
      step_index: 0,
      attempt: 1,
      status: 'succeeded',
      tool_call_count: 3,
    },
    { id: id(23), run_id: id(12), step_id: 'pause', step_index: 0, attempt: 1, status: 'waiting' },
    {
      id: id(24),
      run_id: id(11),
      step_id: 'turn',
      step_index: 0,
      attempt: 1,
      iteration: 1,
      status: 'succeeded',
    },
  ],
  agent_action_batches: [
    {
      id: id(31),
      run_id: id(12),
      agent_id: id(1),
      owner_subject: 'ann',
      turn: 2,
      summary: 'b',
      actions: [],
      created_at: at(5),
    },
    {
      id: id(32),
      run_id: id(12),
      agent_id: id(1),
      owner_subject: 'ann',
      turn: 1,
      summary: 'a',
      actions: [{ tool: 'x' }],
      results: [{ ok: true }],
      created_at: at(4),
    },
  ],
  actionable_items: [
    {
      id: id(41),
      owner_subject: 'ann',
      source: 'agent',
      kind: 'approval',
      title: 'Approve',
      summary: 'two changes',
      run_id: id(13),
      created_by_agent_id: id(1),
      suggested_action: { actions: [] },
      evidence: {},
      created_at: new Date('2026-01-01T00:10:00.000Z'),
    },
    {
      id: id(42),
      owner_subject: 'ann',
      source: 'agent',
      kind: 'question',
      title: 'Which?',
      summary: 'q',
      run_id: id(13),
      created_by_agent_id: id(1),
      suggested_action: { message: 'm', form: [] },
      evidence: {},
      created_at: new Date('2026-01-01T00:11:00.000Z'),
    },
    {
      id: id(43),
      owner_subject: 'ann',
      source: 'agent',
      kind: 'approval',
      title: 'Old',
      summary: 'decided',
      run_id: id(13),
      created_by_agent_id: id(1),
      status: 'approved',
      evidence: {},
      created_at: new Date('2026-01-01T00:12:00.000Z'),
    },
    {
      id: id(44),
      owner_subject: 'ann',
      source: 'agent',
      kind: 'approval',
      title: 'Archived',
      summary: 'gone',
      run_id: id(13),
      created_by_agent_id: id(1),
      archived_at: new Date('2026-01-01T00:13:00.000Z'),
      evidence: {},
      created_at: new Date('2026-01-01T00:09:00.000Z'),
    },
    {
      id: id(45),
      owner_subject: 'ann',
      source: 'agent',
      kind: 'approval',
      title: 'No agent',
      summary: 'manual',
      run_id: null,
      evidence: {},
      created_at: new Date('2026-01-01T00:08:00.000Z'),
    },
    {
      id: id(46),
      owner_subject: 'bob',
      source: 'agent',
      kind: 'approval',
      title: 'Bob',
      summary: 'bob',
      run_id: id(15),
      created_by_agent_id: id(2),
      evidence: {},
      created_at: new Date('2026-01-01T00:07:00.000Z'),
    },
    {
      id: id(47),
      owner_subject: 'ann',
      source: 'agent',
      kind: 'approval',
      title: 'Same time',
      summary: 'tie',
      run_id: null,
      created_by_agent_id: id(1),
      evidence: {},
      created_at: new Date('2026-01-01T00:10:00.000Z'),
    },
  ],
};

const listing = { agentId: id(1), limit: 50 } as const;

/** Relative to now: the evidence window is "the last N days". */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

function logged(n: number, status: string, days: number, extra: Record<string, unknown> = {}) {
  return {
    run_id: id(n),
    agent_id: id(1),
    owner_subject: 'ann',
    trigger_kind: 'manual',
    status,
    created_at: daysAgo(days),
    input_tokens: n * 10,
    output_tokens: n,
    attempts: n % 3,
    tool_calls: n % 4,
    ...extra,
  };
}

const evidence = {
  agents,
  agent_run_log: [
    logged(51, 'failed', 1, { error: 'boom', error_kind: 'tool', outcome_code: 'x' }),
    logged(52, 'failed', 2),
    logged(53, 'failed', 2),
    logged(54, 'succeeded', 3),
    logged(55, 'stopped', 4),
    logged(56, 'running', 1),
    logged(57, 'failed', 60),
    logged(58, 'failed', 1, { owner_subject: 'bob' }),
  ],
  agent_runs: [
    run(61, 1, 'ann', 0, { created_at: daysAgo(1) }),
    run(62, 1, 'ann', 0, { created_at: daysAgo(90) }),
  ],
  agent_run_steps: [
    {
      id: id(71),
      run_id: id(61),
      step_id: 'turn',
      step_index: 0,
      attempt: 1,
      status: 'succeeded',
      detail: {
        toolCalls: [
          { tool: 'jira_search', isError: true },
          { tool: 'jira_search' },
          { tool: 'mail_send', isError: 'true' },
          { tool: 'resolve_time', free: true },
          { name: 'no tool key' },
          'not an object',
        ],
      },
    },
    {
      id: id(72),
      run_id: id(61),
      step_id: 'turn',
      step_index: 0,
      attempt: 2,
      status: 'succeeded',
      detail: { toolCalls: [{ tool: 'calendar_list' }, { tool: 'mail_send' }] },
    },
    {
      id: id(73),
      run_id: id(61),
      step_id: 'turn',
      step_index: 0,
      attempt: 3,
      status: 'failed',
      detail: { toolCalls: 'nope' },
    },
    {
      id: id(74),
      run_id: id(62),
      step_id: 'turn',
      step_index: 0,
      attempt: 1,
      status: 'succeeded',
      detail: { toolCalls: [{ tool: 'old' }] },
    },
  ],
};

function step(
  n: number,
  runId: number,
  index: number,
  attempt: number,
  status: string,
  code: string | null
) {
  return {
    id: id(n),
    run_id: id(runId),
    step_id: `turn-${index}`,
    step_index: index,
    attempt,
    status,
    outcome_code: code,
    input_tokens: 10 * n,
    output_tokens: n,
    tool_call_count: index,
  };
}

const lifecycleFixture = {
  agents,
  agent_runs: [
    run(61, 1, 'ann', 1, { status: 'failed', error: 'boom', error_kind: 'tool' }),
    run(62, 1, 'ann', 3, { status: 'queued' }),
    run(63, 1, 'ann', 3, { status: 'running' }),
    run(64, 2, 'bob', 2, { status: 'succeeded' }),
  ],
  agent_run_steps: [
    step(81, 61, 0, 1, 'failed', 'first-failure'),
    step(82, 61, 1, 1, 'succeeded', null),
    step(83, 61, 1, 2, 'failed', 'last-failure'),
  ],
  agent_run_log: [
    {
      run_id: id(61),
      agent_id: id(1),
      owner_subject: 'ann',
      trigger_kind: 'manual',
      status: 'failed',
      created_at: at(1),
      finished_at: at(2),
    },
  ],
};

/** What the executor's methods start from (worker-agents engine and actions). */
const execution = {
  agents,
  agent_runs: [
    run(12, 1, 'ann', 1, { status: 'succeeded', trigger_kind: 'event' }),
    run(11, 1, 'ann', 2, {
      status: 'running',
      trigger_kind: 'agent',
      parent_run_id: id(12),
      lineage: [id(1), 'older'],
      active_ms: '1500',
      started_at: at(2),
      initial_state: { subject: 'Report' },
      definition_snapshot: { instructions: 'x', tools: ['jira_get_issue'] },
      resumed_at: at(3),
      resume_guidance: 'try again',
      resume_failure: 'it broke',
    }),
    run(13, 2, 'bob', 4, {
      status: 'waiting',
      waiting_until: at(60),
      cancel_requested_at: at(30),
      error_kind: 'needs-sign-in',
      error: 'Paused',
    }),
  ],
  agent_run_steps: [
    {
      id: id(21),
      run_id: id(11),
      step_id: 'turn',
      step_index: 2,
      attempt: 2,
      status: 'running',
      created_at: at(6),
      detail: { assistant: [] },
    },
    {
      id: id(22),
      run_id: id(11),
      step_id: 'turn',
      step_index: 1,
      attempt: 1,
      status: 'succeeded',
      tool_call_count: 3,
      created_at: at(5),
      detail: { opening: 'hi' },
    },
    {
      id: id(23),
      run_id: id(11),
      step_id: 'pause',
      step_index: 1,
      attempt: 1,
      status: 'waiting',
      created_at: at(5),
    },
    {
      id: id(24),
      run_id: id(13),
      step_id: 'turn',
      step_index: 1,
      attempt: 1,
      status: 'waiting',
      created_at: at(7),
    },
    {
      id: id(25),
      run_id: id(13),
      step_id: 'turn',
      step_index: 2,
      attempt: 2,
      status: 'succeeded',
      created_at: at(8),
    },
  ],
  agent_action_batches: [
    {
      id: id(33),
      run_id: id(13),
      agent_id: id(2),
      owner_subject: 'bob',
      turn: 1,
      status: 'proposed',
      summary: 'one change',
      updated_at: at(9),
      actions: [{ tool: 'jira_update', args: {}, reason: 'r' }],
      review_reason: 'policy',
      waiting_until: at(60),
      created_at: at(9),
    },
    {
      id: id(34),
      run_id: id(11),
      agent_id: id(1),
      owner_subject: 'ann',
      turn: 1,
      status: 'accepted',
      summary: 'accepted',
      updated_at: at(9),
      actions: [],
      accepted_by: 'person',
      created_at: at(9),
    },
    {
      id: id(35),
      run_id: id(11),
      agent_id: id(1),
      owner_subject: 'ann',
      turn: 2,
      status: 'executing',
      summary: 'executing',
      updated_at: at(10),
      actions: [{ tool: 'x', args: {}, reason: 'r' }],
      results: [],
      comment: 'go',
      created_at: at(10),
    },
  ],
  actionable_items: [
    {
      id: id(41),
      owner_subject: 'bob',
      source: 'agents',
      kind: 'approval',
      title: 'Approve',
      summary: 's',
      evidence: [],
      run_id: id(13),
      step_id: 'turn',
      iteration: 0,
      attempt: 1,
      created_by_agent_id: id(2),
      created_at: at(11),
    },
    {
      id: id(42),
      owner_subject: 'bob',
      source: 'agents',
      kind: 'question',
      title: 'Which?',
      summary: 'q',
      evidence: [],
      status: 'answered',
      decided_by: 'bob',
      result: { answers: { pick: 'a' } },
      run_id: id(13),
      step_id: 'turn',
      iteration: 0,
      attempt: 2,
      created_by_agent_id: id(2),
      created_at: at(12),
    },
    {
      id: id(43),
      owner_subject: 'ann',
      source: 'agents',
      kind: 'approval',
      title: 'Ann approve',
      summary: 'a',
      evidence: [],
      run_id: id(11),
      step_id: 'turn',
      iteration: 0,
      attempt: 1,
      created_by_agent_id: id(1),
      created_at: at(13),
    },
  ],
};

export const agentRunScenarios: Scenario<DataStore>[] = [
  {
    method: 'agentRuns.list',
    name: 'newest first, ties by id; owner-scoped or all; status and limit',
    fixture,
    run: async (store) => [
      await store.agentRuns.list({ ...listing, ownerSubject: 'ann', audience: 'owner' }),
      await store.agentRuns.list({ ...listing, ownerSubject: null, audience: 'admin' }),
      await store.agentRuns.list({ ...listing, ownerSubject: null, audience: 'admin', limit: 2 }),
      await store.agentRuns.list({
        ...listing,
        ownerSubject: 'ann',
        audience: 'owner',
        status: 'failed',
      }),
      await store.agentRuns.list({
        ...listing,
        agentId: id(9),
        ownerSubject: null,
        audience: 'admin',
      }),
    ],
  },
  {
    method: 'agentRuns.list',
    name: 'search: error, trigger kind, input (admin: failed only), escaped wildcards, id',
    fixture,
    run: async (store) => {
      const ids = async (options: { q?: string; matchId?: string; audience: 'owner' | 'admin' }) =>
        (
          await store.agentRuns.list({
            ...listing,
            ownerSubject: options.audience === 'owner' ? 'ann' : null,
            ...options,
          })
        ).map((r) => r.id);
      return [
        await ids({ q: 'jira', audience: 'owner' }),
        await ids({ q: '500_', audience: 'owner' }),
        await ids({ q: '50%', audience: 'owner' }),
        await ids({ q: 'SCHEDULE', audience: 'owner' }),
        await ids({ q: 'report', audience: 'owner' }),
        await ids({ q: 'report', audience: 'admin' }),
        await ids({ q: '"count": 2', audience: 'owner' }),
        await ids({ q: id(14), matchId: id(14), audience: 'admin' }),
      ];
    },
  },
  {
    method: 'agentRuns.findDetail',
    name: 'owner sees content; admin only on a failed run; steps and batches in order',
    fixture,
    run: async (store) => [
      await store.agentRuns.findDetail({
        agentId: id(1),
        runId: id(12),
        ownerSubject: 'ann',
        audience: 'owner',
      }),
      await store.agentRuns.findDetail({
        agentId: id(1),
        runId: id(11),
        ownerSubject: 'ann',
        audience: 'owner',
      }),
      await store.agentRuns.findDetail({
        agentId: id(1),
        runId: id(11),
        ownerSubject: null,
        audience: 'admin',
      }),
      await store.agentRuns.findDetail({
        agentId: id(1),
        runId: id(12),
        ownerSubject: null,
        audience: 'admin',
      }),
      await store.agentRuns.findDetail({
        agentId: id(1),
        runId: id(12),
        ownerSubject: 'bob',
        audience: 'owner',
      }),
      await store.agentRuns.findDetail({
        agentId: id(2),
        runId: id(12),
        ownerSubject: null,
        audience: 'admin',
      }),
    ],
  },
  {
    method: 'agentRuns.findPauseCard',
    name: "the newest undecided approval or question, the owner's",
    fixture,
    run: async (store) => [
      await store.agentRuns.findPauseCard(id(13), 'ann'),
      await store.agentRuns.findPauseCard(id(13), 'bob'),
      await store.agentRuns.findPauseCard(id(11), 'ann'),
    ],
  },
  {
    method: 'agentRuns.findStatus',
    name: 'scoped to agent and, when given, owner',
    fixture,
    run: async (store) => [
      await store.agentRuns.findStatus({ agentId: id(1), runId: id(13) }),
      await store.agentRuns.findStatus({ agentId: id(1), runId: id(13), ownerSubject: 'ann' }),
      await store.agentRuns.findStatus({ agentId: id(1), runId: id(13), ownerSubject: 'bob' }),
      await store.agentRuns.findStatus({ agentId: id(2), runId: id(13) }),
    ],
  },
  {
    method: 'agentRuns.requestCancel',
    name: 'once per live run; settled runs refuse',
    fixture,
    run: async (store) => {
      const claims = [
        await store.agentRuns.requestCancel(id(13), 'ann'),
        await store.agentRuns.requestCancel(id(13), 'bob'),
        await store.agentRuns.requestCancel(id(11), 'ann'),
        await store.agentRuns.requestCancel(id(15), 'bob'),
      ];
      return { claims, still: await store.agentRuns.findStatus({ agentId: id(1), runId: id(13) }) };
    },
  },
  {
    method: 'agentRuns.requeueWaiting',
    name: "the owner's runs parked on that error kind only",
    fixture: {
      agents,
      agent_runs: [
        run(11, 1, 'ann', 1, { status: 'waiting', error_kind: 'needs-sign-in', error: 'sign in' }),
        run(12, 1, 'ann', 2, { status: 'waiting', error_kind: 'other' }),
        run(13, 2, 'ann', 3, { status: 'waiting', error_kind: 'needs-sign-in' }),
        run(14, 2, 'bob', 4, { status: 'waiting', error_kind: 'needs-sign-in' }),
        run(15, 1, 'ann', 5, { status: 'failed', error_kind: 'needs-sign-in' }),
      ],
    },
    run: async (store) => [
      await store.agentRuns.requeueWaiting('ann', 'needs-sign-in'),
      await store.agentRuns.requeueWaiting('ann', 'needs-sign-in'),
      await store.agentRuns.list({
        agentId: id(1),
        ownerSubject: 'ann',
        audience: 'owner',
        limit: 10,
      }),
    ],
  },
  {
    method: 'agentRuns.listPendingCards',
    name: 'undecided, unarchived, agent-raised; oldest first; by agent; bounded',
    fixture,
    run: async (store) => [
      await store.agentRuns.listPendingCards('ann', { kind: 'approval', limit: 20 }),
      await store.agentRuns.listPendingCards('ann', { kind: 'approval', limit: 1 }),
      await store.agentRuns.listPendingCards('ann', {
        kind: 'question',
        agentId: id(1),
        limit: 20,
      }),
      await store.agentRuns.listPendingCards('ann', {
        kind: 'approval',
        agentId: id(2),
        limit: 20,
      }),
      await store.agentRuns.listPendingCards('nobody', { kind: 'approval', limit: 20 }),
    ],
  },
  {
    method: 'agentRuns.findCard',
    name: "the person's own card only",
    fixture,
    run: async (store) => [
      await store.agentRuns.findCard(id(41), 'ann'),
      await store.agentRuns.findCard(id(41), 'bob'),
      await store.agentRuns.findCard(id(99), 'ann'),
    ],
  },
  {
    method: 'agentRuns.claimCard',
    name: 'one decider wins; the decision reads back',
    fixture,
    run: async (store) => {
      const decision = { status: 'approved', result: { decidedBy: 'ann' }, decidedBy: 'ann' };
      return [
        await store.agentRuns.claimCard(id(41), decision),
        await store.agentRuns.claimCard(id(41), { ...decision, status: 'declined' }),
        await store.agentRuns.claimCard(id(43), decision),
        await store.agentRuns.findCard(id(41), 'ann'),
        (await store.agentRuns.listPendingCards('ann', { kind: 'approval', limit: 20 })).map(
          (card) => card.cardId
        ),
      ];
    },
  },
  {
    method: 'agentRuns.optimizationEvidence',
    name: 'failures, settled-run stats and the tool profile within the window',
    fixture: evidence,
    run: async (store) => [
      await store.agentRuns.optimizationEvidence({
        ownerSubject: 'ann',
        agentId: id(1),
        days: 30,
        maxFailures: 2,
        maxTools: 2,
      }),
      await store.agentRuns.optimizationEvidence({
        ownerSubject: 'ann',
        agentId: id(1),
        days: 30,
        maxFailures: 10,
        maxTools: 10,
      }),
      await store.agentRuns.optimizationEvidence({
        ownerSubject: 'bob',
        agentId: id(1),
        days: 30,
        maxFailures: 10,
        maxTools: 10,
      }),
    ],
  },
  {
    method: 'agentRuns.findRunAgent',
    name: 'the run and its agent, or null',
    fixture,
    run: async (store) => [
      await store.agentRuns.findRunAgent(id(15)),
      await store.agentRuns.findRunAgent(id(99)),
    ],
  },
  {
    method: 'agentRuns.findRestartSource',
    name: 'scoped to agent and owner; the trigger input as stored',
    fixture,
    run: async (store) => [
      await store.agentRuns.findRestartSource({
        agentId: id(1),
        runId: id(11),
        ownerSubject: 'ann',
      }),
      await store.agentRuns.findRestartSource({
        agentId: id(1),
        runId: id(13),
        ownerSubject: 'ann',
      }),
      await store.agentRuns.findRestartSource({
        agentId: id(1),
        runId: id(11),
        ownerSubject: 'bob',
      }),
      await store.agentRuns.findRestartSource({
        agentId: id(2),
        runId: id(11),
        ownerSubject: 'ann',
      }),
      await store.agentRuns.findRestartSource({
        agentId: id(1),
        runId: id(99),
        ownerSubject: 'ann',
      }),
    ],
  },
  {
    method: 'agentRuns.forceCancel',
    name: 'live runs only; running attempts closed, other attempts and runs untouched',
    fixture: {
      agents,
      agent_runs: [
        run(11, 1, 'ann', 1, { status: 'running' }),
        run(12, 1, 'ann', 2, {
          status: 'waiting',
          cancel_requested_at: at(3),
          cancel_requested_by: 'ann',
        }),
        run(13, 1, 'ann', 3, { status: 'succeeded' }),
        run(14, 1, 'ann', 4, { status: 'running' }),
      ],
      agent_run_steps: [
        {
          id: id(21),
          run_id: id(11),
          step_id: 'turn',
          step_index: 0,
          attempt: 1,
          status: 'succeeded',
        },
        {
          id: id(22),
          run_id: id(11),
          step_id: 'turn-2',
          step_index: 1,
          attempt: 1,
          status: 'running',
        },
        {
          id: id(23),
          run_id: id(12),
          step_id: 'pause',
          step_index: 0,
          attempt: 1,
          status: 'waiting',
        },
        {
          id: id(24),
          run_id: id(14),
          step_id: 'turn',
          step_index: 0,
          attempt: 1,
          status: 'running',
        },
      ],
    },
    run: async (store) => {
      const input = { bySubject: 'admin', errorKind: 'force_halted', error: 'Force-halted.' };
      const claims = [
        await store.agentRuns.forceCancel(id(11), input),
        await store.agentRuns.forceCancel(id(11), input),
        await store.agentRuns.forceCancel(id(12), input),
        await store.agentRuns.forceCancel(id(13), input),
        await store.agentRuns.forceCancel(id(99), input),
      ];
      const runs = await Promise.all(
        [11, 12, 13, 14].map(async (n) => {
          const detail = await store.agentRuns.findDetail({
            agentId: id(1),
            runId: id(n),
            ownerSubject: 'ann',
            audience: 'owner',
          });
          return detail
            ? {
                status: detail.status,
                errorKind: detail.errorKind,
                error: detail.error,
                finished: detail.finishedAt !== null,
                steps: detail.steps.map((step) => ({
                  stepIndex: step.stepIndex,
                  status: step.status,
                  finished: step.finishedAt !== null,
                })),
              }
            : null;
        })
      );
      return { claims, runs };
    },
  },
  {
    method: 'agentRuns.countCreatedSince',
    name: 'strictly after the cutoff, everyone',
    fixture: lifecycleFixture,
    run: async (store) => [
      await store.agentRuns.countCreatedSince(new Date(at(0))),
      await store.agentRuns.countCreatedSince(new Date(at(2))),
      await store.agentRuns.countCreatedSince(new Date(at(99))),
    ],
  },
  {
    method: 'agentRuns.createQueued',
    name: 'a queued row with its snapshot and depth',
    fixture: lifecycleFixture,
    run: async (store) => {
      await store.agentRuns.createQueued({
        id: id(70),
        agentId: id(1),
        ownerSubject: 'ann',
        triggerId: null,
        triggerKind: 'agent',
        triggeredBySubject: 'ann',
        parentRunId: id(61),
        lineage: [id(2), id(1)],
        definitionSnapshot: { instructions: 'do it', tools: ['a'] },
        llmModelId: null,
        initialState: { issue: 'ABC-1' },
      });
      return {
        inProgress: await store.agentRuns.findInProgress(id(1)),
        resume: await store.agentRuns.findForResume(id(70), id(1), 'ann'),
      };
    },
  },
  {
    method: 'agentRuns.deleteRun',
    name: 'one row; an unknown id deletes nothing',
    fixture: lifecycleFixture,
    run: async (store) => [
      await store.agentRuns.deleteRun(id(62)),
      await store.agentRuns.deleteRun(id(62)),
      await store.agentRuns.findInProgress(id(1)),
    ],
  },
  {
    method: 'agentRuns.logRunCreated',
    name: 'a queued log row; recordOutcome later finalizes it',
    fixture: lifecycleFixture,
    run: async (store) => {
      await store.agentRuns.logRunCreated({
        runId: id(62),
        agentId: id(1),
        ownerSubject: 'ann',
        triggerKind: 'manual',
        status: 'queued',
      });
      const row = await store.agentRuns.findRunLog(id(62));
      return { row: row && { ...row, createdAt: null } };
    },
  },
  {
    method: 'agentRuns.findRunLog',
    name: 'the row as stored; a run with none reads null',
    fixture: lifecycleFixture,
    run: async (store) => [
      await store.agentRuns.findRunLog(id(61)),
      await store.agentRuns.findRunLog(id(62)),
    ],
  },
  {
    method: 'agentRuns.findInProgress',
    name: 'newest queued or running run of the agent, ties by id descending',
    fixture: lifecycleFixture,
    run: async (store) => [
      await store.agentRuns.findInProgress(id(1)),
      await store.agentRuns.findInProgress(id(2)),
    ],
  },
  {
    method: 'agentRuns.findForResume',
    name: "this agent's and owner's run only",
    fixture: lifecycleFixture,
    run: async (store) => [
      await store.agentRuns.findForResume(id(61), id(1), 'ann'),
      await store.agentRuns.findForResume(id(61), id(2), 'ann'),
      await store.agentRuns.findForResume(id(61), id(1), 'bob'),
      await store.agentRuns.findForResume(id(69), id(1), 'ann'),
    ],
  },
  {
    method: 'agentRuns.markResumed',
    name: 'failed runs only, once',
    fixture: lifecycleFixture,
    run: async (store) => [
      await store.agentRuns.markResumed(id(61), {
        resumedBy: 'ann',
        guidance: 'try the other project',
        failure: 'boom',
      }),
      await store.agentRuns.markResumed(id(61), {
        resumedBy: 'ann',
        guidance: null,
        failure: null,
      }),
      await store.agentRuns.markResumed(id(62), {
        resumedBy: 'ann',
        guidance: null,
        failure: null,
      }),
      await store.agentRuns.findForResume(id(61), id(1), 'ann'),
      await store.agentRuns.findInProgress(id(1)),
    ],
  },
  {
    method: 'agentRuns.restoreFailure',
    name: 'a queued run back to failed; others untouched',
    fixture: lifecycleFixture,
    run: async (store) => {
      await store.agentRuns.restoreFailure(id(62), { error: 'lost', errorKind: 'queue' });
      await store.agentRuns.restoreFailure(id(63), { error: 'x', errorKind: 'x' });
      return [
        await store.agentRuns.findForResume(id(62), id(1), 'ann'),
        await store.agentRuns.findForResume(id(63), id(1), 'ann'),
      ];
    },
  },
  {
    method: 'agentRuns.markLogQueued',
    name: 'the log row reads queued again; a run with no log row is a no-op',
    fixture: lifecycleFixture,
    run: async (store) => {
      await store.agentRuns.markLogQueued(id(61));
      await store.agentRuns.markLogQueued(id(63));
      return [await store.agentRuns.findRunLog(id(61)), await store.agentRuns.findRunLog(id(63))];
    },
  },
  {
    method: 'agentRuns.recordOutcome',
    name: 'spend summed from the attempts, newest failed code kept, upserted',
    fixture: lifecycleFixture,
    run: async (store) => {
      await store.agentRuns.recordOutcome({
        runId: id(61),
        agentId: id(1),
        ownerSubject: 'ann',
        status: 'failed',
        errorKind: 'tool',
        error: 'it broke',
        failed: true,
      });
      await store.agentRuns.recordOutcome({
        runId: id(63),
        agentId: id(1),
        ownerSubject: 'ann',
        status: 'succeeded',
        errorKind: null,
        error: null,
        failed: false,
      });
      const twice = await store.agentRuns
        .recordOutcome({
          runId: id(63),
          agentId: id(1),
          ownerSubject: 'ann',
          status: 'canceled',
          errorKind: null,
          error: null,
          failed: false,
        })
        .then(() => 'accepted');
      const failed = await store.agentRuns.findRunLog(id(61));
      const done = await store.agentRuns.findRunLog(id(63));
      return {
        twice,
        failed: failed && { ...failed, finishedAt: failed.finishedAt !== null },
        done: done && { ...done, finishedAt: done.finishedAt !== null },
      };
    },
  },
  {
    method: 'agentRuns.findRunOrigin',
    name: 'the run’s agent and trigger kind, or null',
    fixture,
    run: async (store) => [
      await store.agentRuns.findRunOrigin(id(15)),
      await store.agentRuns.findRunOrigin(id(99)),
    ],
  },
  {
    method: 'agentRuns.findForExecution',
    name: 'the executor columns, active time as a number; a missing run is null',
    fixture: execution,
    run: async (store) => [
      await store.agentRuns.findForExecution(id(11)),
      await store.agentRuns.findForExecution(id(13)),
      await store.agentRuns.findForExecution(id(99)),
    ],
  },
  {
    method: 'agentRuns.updateExecution',
    name: 'only the fields given are written; other runs untouched',
    fixture: execution,
    run: async (store) => {
      await store.agentRuns.updateExecution(id(11), {
        status: 'waiting',
        waitingUntil: new Date(at(90)),
        activeMs: 4200,
      });
      await store.agentRuns.updateExecution(id(13), {
        status: 'running',
        startedAt: new Date(at(40)),
        llmModelId: null,
        errorKind: null,
        error: null,
      });
      await store.agentRuns.updateExecution(id(12), {});
      return Promise.all(
        [11, 12, 13].map(async (n) => {
          const run = await store.agentRuns.findForExecution(id(n));
          const detail = await store.agentRuns.findDetail({
            agentId: run?.agentId ?? id(1),
            runId: id(n),
            ownerSubject: null,
            audience: 'owner',
          });
          return { run, error: detail?.error ?? null };
        })
      );
    },
  },
  {
    method: 'agentRuns.findCancelState',
    name: 'status and the cancel request; a missing run is null',
    fixture: execution,
    run: async (store) => [
      await store.agentRuns.findCancelState(id(11)),
      await store.agentRuns.findCancelState(id(13)),
      await store.agentRuns.findCancelState(id(99)),
    ],
  },
  {
    method: 'agentRuns.findChainLink',
    name: 'trigger kind, parent and lineage as stored; a missing run is null',
    fixture: execution,
    run: async (store) => [
      await store.agentRuns.findChainLink(id(11)),
      await store.agentRuns.findChainLink(id(12)),
      await store.agentRuns.findChainLink(id(99)),
    ],
  },
  {
    method: 'agentRuns.listTurns',
    name: "one step's rows of one run, by attempt then id",
    fixture: execution,
    run: async (store) => [
      await store.agentRuns.listTurns(id(11), 'turn'),
      await store.agentRuns.listTurns(id(11), 'pause'),
      await store.agentRuns.listTurns(id(12), 'turn'),
    ],
  },
  {
    method: 'agentRuns.openTurn',
    name: 'a running row at iteration 0; the same attempt twice is refused',
    fixture: execution,
    run: async (store) => {
      await store.agentRuns.openTurn({
        id: id(30),
        runId: id(12),
        stepId: 'turn',
        attempt: 1,
        detail: JSON.stringify({ opening: 'hello' }),
      });
      let second: unknown = 'inserted';
      try {
        await store.agentRuns.openTurn({
          id: id(31),
          runId: id(12),
          stepId: 'turn',
          attempt: 1,
          detail: '{}',
        });
      } catch (error) {
        second = refusal(error);
      }
      const turns = await store.agentRuns.listTurns(id(12), 'turn');
      const detail = await store.agentRuns.findDetail({
        agentId: id(1),
        runId: id(12),
        ownerSubject: 'ann',
        audience: 'owner',
      });
      return {
        second,
        turns: turns.map(({ createdAt: _createdAt, ...turn }) => turn),
        steps: detail?.steps.map((step) => ({
          stepIndex: step.stepIndex,
          iteration: step.iteration,
          started: step.startedAt !== null,
          finished: step.finishedAt !== null,
        })),
      };
    },
  },
  {
    method: 'agentRuns.writeTurn',
    name: 'status, billing and detail rewritten; finished only when asked',
    fixture: execution,
    run: async (store) => {
      const write = {
        toolCallCount: 4,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: 7,
        detail: JSON.stringify({ finish: 'done' }),
      };
      await store.agentRuns.writeTurn(id(21), {
        ...write,
        status: 'waiting',
        outcome: 'actions',
        finished: false,
      });
      await store.agentRuns.writeTurn(id(22), {
        ...write,
        status: 'succeeded',
        outcome: 'done',
        finished: true,
      });
      const detail = await store.agentRuns.findDetail({
        agentId: id(1),
        runId: id(11),
        ownerSubject: 'ann',
        audience: 'owner',
      });
      return detail?.steps.map((step) => ({
        attempt: step.attempt,
        stepId: step.stepId,
        status: step.status,
        outcome: step.outcome,
        toolCallCount: step.toolCallCount,
        detail: step.detail,
        finished: step.finishedAt !== null,
      }));
    },
  },
  {
    method: 'agentRuns.closeOpenTurns',
    name: "the run's running and waiting rows only; other runs untouched",
    fixture: execution,
    run: async (store) => {
      await store.agentRuns.closeOpenTurns(id(11), 'failed');
      const turns = await Promise.all(
        [11, 13].map(async (n) => [
          ...(await store.agentRuns.listTurns(id(n), 'turn')),
          ...(await store.agentRuns.listTurns(id(n), 'pause')),
        ])
      );
      return turns.map((list) => list.map((turn) => ({ id: turn.id, status: turn.status })));
    },
  },
  {
    method: 'agentRuns.finishExecution',
    name: 'the run ended with its error, no deadline; open rows canceled, settled rows kept',
    fixture: execution,
    run: async (store) => {
      await store.agentRuns.finishExecution(id(13), {
        status: 'failed',
        errorKind: 'timeout',
        error: 'out of time',
      });
      const run = await store.agentRuns.findForExecution(id(13));
      const detail = await store.agentRuns.findDetail({
        agentId: id(2),
        runId: id(13),
        ownerSubject: 'bob',
        audience: 'owner',
      });
      const other = await store.agentRuns.listTurns(id(11), 'turn');
      return {
        status: run?.status,
        errorKind: run?.errorKind,
        error: detail?.error,
        waitingUntil: run?.waitingUntil,
        finished: detail?.finishedAt !== null,
        steps: detail?.steps.map((step) => ({
          status: step.status,
          finished: step.finishedAt !== null,
        })),
        other: other.map((turn) => turn.status),
      };
    },
  },
  {
    method: 'agentRuns.cancelWaiting',
    name: 'run, undecided cards, proposed batches and open rows of that run only',
    fixture: execution,
    run: async (store) => {
      await store.agentRuns.cancelWaiting(id(13), 'canceled-by-owner');
      const run = await store.agentRuns.findForExecution(id(13));
      const detail = await store.agentRuns.findDetail({
        agentId: id(2),
        runId: id(13),
        ownerSubject: 'bob',
        audience: 'owner',
      });
      const cards = await Promise.all(
        [
          [13, 1],
          [13, 2],
          [11, 1],
        ].map(([run, attempt]) => store.agentRuns.findTurnCard(id(run), 'turn', attempt))
      );
      const batches = await Promise.all(
        [33, 34, 35].map((n) => store.agentRuns.findBatchState(id(n)))
      );
      return {
        status: run?.status,
        waitingUntil: run?.waitingUntil,
        finished: detail?.finishedAt !== null,
        steps: detail?.steps.map((step) => step.status),
        cards,
        batches: batches.map((batch) => batch?.status),
      };
    },
  },
  {
    method: 'agentRuns.stageBatch',
    name: 'proposed and auto-accepted batches; a second batch for the turn is refused',
    fixture: execution,
    run: async (store) => {
      const base = {
        runId: id(12),
        agentId: id(1),
        ownerSubject: 'ann',
        summary: 'tidy up',
        actions: [{ tool: 'jira_update', args: { key: 'A-1' }, reason: 'stale' }],
      };
      await store.agentRuns.stageBatch({
        ...base,
        id: id(36),
        turn: 1,
        status: 'proposed',
        reviewReason: 'policy',
        acceptedBy: null,
        decided: false,
        waitingUntil: new Date(at(120)),
      });
      await store.agentRuns.stageBatch({
        ...base,
        id: id(37),
        turn: 2,
        status: 'accepted',
        reviewReason: null,
        acceptedBy: 'auto',
        decided: true,
        waitingUntil: null,
      });
      let again: unknown = 'inserted';
      try {
        await store.agentRuns.stageBatch({
          ...base,
          id: id(38),
          turn: 2,
          status: 'accepted',
          reviewReason: null,
          acceptedBy: 'auto',
          decided: true,
          waitingUntil: null,
        });
      } catch (error) {
        again = refusal(error);
      }
      const states = await Promise.all(
        [36, 37, 38].map(async (n) => {
          const state = await store.agentRuns.findBatchState(id(n));
          if (!state) return null;
          const { updatedAt: _updatedAt, ...rest } = state;
          return rest;
        })
      );
      const detail = await store.agentRuns.findDetail({
        agentId: id(1),
        runId: id(12),
        ownerSubject: 'ann',
        audience: 'owner',
      });
      return {
        again,
        states,
        batches: detail?.batches.map((batch) => ({
          turn: batch.turn,
          reviewReason: batch.reviewReason,
          finished: batch.finishedAt !== null,
        })),
      };
    },
  },
  {
    method: 'agentRuns.findBatchState',
    name: "the batch with its run's state and agent name; a missing batch is null",
    fixture: execution,
    run: async (store) => [
      await store.agentRuns.findBatchState(id(33)),
      await store.agentRuns.findBatchState(id(35)),
      await store.agentRuns.findBatchState(id(99)),
    ],
  },
  {
    method: 'agentRuns.settleProposedBatch',
    name: 'a proposed batch moves once; one already moved does not',
    fixture: execution,
    run: async (store) => {
      const decision = {
        status: 'declined',
        acceptedBy: null,
        decidedBy: 'bob',
        comment: 'not now',
      };
      const moved = [
        await store.agentRuns.settleProposedBatch(id(33), decision),
        await store.agentRuns.settleProposedBatch(id(33), { ...decision, status: 'accepted' }),
        await store.agentRuns.settleProposedBatch(id(34), decision),
        await store.agentRuns.settleProposedBatch(id(99), decision),
      ];
      const states = await Promise.all([33, 34].map((n) => store.agentRuns.findBatchState(id(n))));
      return {
        moved,
        states: states.map((s) => ({ status: s?.status, comment: s?.comment, by: s?.acceptedBy })),
      };
    },
  },
  {
    method: 'agentRuns.expireLiveBatch',
    name: 'accepted and executing batches expire with the comment; others stay',
    fixture: execution,
    run: async (store) => {
      for (const n of [33, 34, 35]) {
        await store.agentRuns.expireLiveBatch(id(n), 'The run ended.');
      }
      const states = await Promise.all(
        [33, 34, 35].map((n) => store.agentRuns.findBatchState(id(n)))
      );
      return states.map((s) => ({ status: s?.status, comment: s?.comment }));
    },
  },
  {
    method: 'agentRuns.claimBatch',
    name: 'an accepted batch is claimed once; anything else is not',
    fixture: execution,
    run: async (store) => {
      const claims = [
        await store.agentRuns.claimBatch(id(34)),
        await store.agentRuns.claimBatch(id(34)),
        await store.agentRuns.claimBatch(id(33)),
        await store.agentRuns.claimBatch(id(99)),
      ];
      const states = await Promise.all([33, 34].map((n) => store.agentRuns.findBatchState(id(n))));
      return { claims, states: states.map((s) => s?.status) };
    },
  },
  {
    method: 'agentRuns.saveBatchProgress',
    name: 'results replaced when given; a touch leaves them',
    fixture: execution,
    run: async (store) => {
      await store.agentRuns.saveBatchProgress(id(35), [
        { tool: 'jira_update', outcome: 'succeeded', text: 'Done.', durationMs: 3 },
      ]);
      await store.agentRuns.saveBatchProgress(id(35));
      await store.agentRuns.saveBatchProgress(id(34));
      const states = await Promise.all([34, 35].map((n) => store.agentRuns.findBatchState(id(n))));
      return states.map((s) => ({ status: s?.status, results: s?.results }));
    },
  },
  {
    method: 'agentRuns.completeBatch',
    name: 'completed with its results and finished; other batches untouched',
    fixture: execution,
    run: async (store) => {
      await store.agentRuns.completeBatch(id(35), [{ tool: 'x', outcome: 'skipped' }]);
      const detail = await store.agentRuns.findDetail({
        agentId: id(1),
        runId: id(11),
        ownerSubject: 'ann',
        audience: 'owner',
      });
      return detail?.batches.map((batch) => ({
        id: batch.id,
        status: batch.status,
        results: batch.results,
        finished: batch.finishedAt !== null,
      }));
    },
  },
  {
    method: 'agentRuns.raiseTurnCard',
    name: 'one card per run turn; another attempt or run gets its own',
    fixture: execution,
    run: async (store) => {
      const card = {
        kind: 'approval',
        title: 'Ann agent — wants to make a change',
        summary: 'tidy',
        suggestedAction: { batchId: id(34), summary: 'tidy', actions: [] },
        ownerSubject: 'ann',
        agentId: id(1),
        runId: id(11),
        stepId: 'turn',
      };
      const raised = [
        await store.agentRuns.raiseTurnCard({ ...card, id: id(50), attempt: 2 }),
        await store.agentRuns.raiseTurnCard({ ...card, id: id(51), attempt: 2 }),
        await store.agentRuns.raiseTurnCard({ ...card, id: id(52), attempt: 3 }),
        await store.agentRuns.raiseTurnCard({ ...card, id: id(53), attempt: 2, runId: id(12) }),
      ];
      const pending = await store.agentRuns.listPendingCards('ann', {
        kind: 'approval',
        limit: 10,
      });
      return {
        raised,
        found: await Promise.all(
          [2, 3].map((attempt) => store.agentRuns.findTurnCard(id(11), 'turn', attempt))
        ),
        pending: pending.map((p) => ({
          cardId: p.cardId,
          runId: p.runId,
          title: p.title,
          suggestedAction: p.suggestedAction,
        })),
      };
    },
  },
  {
    method: 'agentRuns.findTurnCard',
    name: "the turn's card with its result and decider; other steps and runs miss",
    fixture: execution,
    run: async (store) => [
      await store.agentRuns.findTurnCard(id(13), 'turn', 1),
      await store.agentRuns.findTurnCard(id(13), 'turn', 2),
      await store.agentRuns.findTurnCard(id(13), 'pause', 1),
      await store.agentRuns.findTurnCard(id(11), 'turn', 1),
    ],
  },
  {
    method: 'agentRuns.expireCard',
    name: 'an undecided card expires once with its result; a decided one does not',
    fixture: execution,
    run: async (store) => {
      const expired = [
        await store.agentRuns.expireCard(id(41), { reason: 'timeout' }),
        await store.agentRuns.expireCard(id(41), { reason: 'again' }),
        await store.agentRuns.expireCard(id(42), { reason: 'timeout' }),
      ];
      return {
        expired,
        cards: await Promise.all(
          [1, 2].map((attempt) => store.agentRuns.findTurnCard(id(13), 'turn', attempt))
        ),
      };
    },
  },
  {
    method: 'agentRuns.findRunError',
    name: 'the error of a failed run, null on a clean one, missing runs null',
    fixture,
    run: async (store) => [
      await store.agentRuns.findRunError(id(12)),
      await store.agentRuns.findRunError(id(11)),
      await store.agentRuns.findRunError(id(99)),
    ],
  },
];

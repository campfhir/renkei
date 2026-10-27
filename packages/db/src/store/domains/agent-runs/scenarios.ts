import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-b${String(n).padStart(11, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
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
      initial_state: JSON.stringify({ subject: 'Quarterly Report', count: 2 }),
      started_at: at(1),
      finished_at: at(2),
      resume_guidance: 'try harder',
    }),
    run(12, 1, 'ann', 3, {
      status: 'failed',
      error: 'Jira said 500_ok',
      error_kind: 'tool',
      initial_state: JSON.stringify({ subject: 'Weekly report' }),
      resume_count: 1,
      resumed_at: at(4),
      active_ms: '1500',
      definition_snapshot: JSON.stringify({ instructions: 'x', tools: [] }),
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
      detail: JSON.stringify({ llmSummary: 'two' }),
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
      actions: JSON.stringify([]),
      created_at: at(5),
    },
    {
      id: id(32),
      run_id: id(12),
      agent_id: id(1),
      owner_subject: 'ann',
      turn: 1,
      summary: 'a',
      actions: JSON.stringify([{ tool: 'x' }]),
      results: JSON.stringify([{ ok: true }]),
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
      suggested_action: JSON.stringify({ actions: [] }),
      evidence: '{}',
      created_at: '2026-01-01T00:10:00.000Z',
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
      suggested_action: JSON.stringify({ message: 'm', form: [] }),
      evidence: '{}',
      created_at: '2026-01-01T00:11:00.000Z',
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
      evidence: '{}',
      created_at: '2026-01-01T00:12:00.000Z',
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
      archived_at: '2026-01-01T00:13:00.000Z',
      evidence: '{}',
      created_at: '2026-01-01T00:09:00.000Z',
    },
    {
      id: id(45),
      owner_subject: 'ann',
      source: 'agent',
      kind: 'approval',
      title: 'No agent',
      summary: 'manual',
      run_id: null,
      evidence: '{}',
      created_at: '2026-01-01T00:08:00.000Z',
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
      evidence: '{}',
      created_at: '2026-01-01T00:07:00.000Z',
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
      evidence: '{}',
      created_at: '2026-01-01T00:10:00.000Z',
    },
  ],
};

const listing = { agentId: id(1), limit: 50 } as const;

/** Relative to now: the evidence window is "the last N days". */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

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
      detail: JSON.stringify({
        toolCalls: [
          { tool: 'jira_search', isError: true },
          { tool: 'jira_search' },
          { tool: 'mail_send', isError: 'true' },
          { tool: 'resolve_time', free: true },
          { name: 'no tool key' },
          'not an object',
        ],
      }),
    },
    {
      id: id(72),
      run_id: id(61),
      step_id: 'turn',
      step_index: 0,
      attempt: 2,
      status: 'succeeded',
      detail: JSON.stringify({ toolCalls: [{ tool: 'calendar_list' }, { tool: 'mail_send' }] }),
    },
    {
      id: id(73),
      run_id: id(61),
      step_id: 'turn',
      step_index: 0,
      attempt: 3,
      status: 'failed',
      detail: JSON.stringify({ toolCalls: 'nope' }),
    },
    {
      id: id(74),
      run_id: id(62),
      step_id: 'turn',
      step_index: 0,
      attempt: 1,
      status: 'succeeded',
      detail: JSON.stringify({ toolCalls: [{ tool: 'old' }] }),
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
      await store.agentRuns
        .findDetail({ agentId: id(1), runId: 'nope', ownerSubject: null, audience: 'admin' })
        .then(() => 'answered', refusal),
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
      const again = await store.agentRuns
        .createQueued({
          id: id(70),
          agentId: id(1),
          ownerSubject: 'ann',
          triggerId: null,
          triggerKind: 'manual',
          triggeredBySubject: null,
          parentRunId: null,
          lineage: [],
          definitionSnapshot: {},
          llmModelId: null,
          initialState: null,
        })
        .then(
          () => 'accepted',
          (error: unknown) => refusal(error)
        );
      return {
        again,
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
      const twice = await store.agentRuns
        .logRunCreated({
          runId: id(62),
          agentId: id(1),
          ownerSubject: 'ann',
          triggerKind: 'manual',
          status: 'queued',
        })
        .then(
          () => 'accepted',
          (error: unknown) => refusal(error)
        );
      const row = await store.agentRuns.findRunLog(id(62));
      return { twice, row: row && { ...row, createdAt: null } };
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
];

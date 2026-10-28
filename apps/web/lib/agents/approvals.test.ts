/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The claim semantics the web feed and the MCP tools now share. What is
 * pinned here is the part that must not drift between them: who may decide,
 * who wins a race, and what a lost wake is allowed to be called.
 */

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type NewRow,
  type TableRows,
} from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import {
  answerQuestion,
  decideApproval,
  listPendingApprovals,
  listPendingQuestions,
} from './approvals';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AGENT = id(1);
const AGENT_2 = id(2);
const RUN = id(11);
const RUN_2 = id(12);
const CARD = id(21);
const QUESTION = id(22);

const store = createMemoryDataStore();

const producer = (ok: boolean): QueueProducer =>
  ({ enqueue: async () => ({ ok }) }) as unknown as QueueProducer;

const BATCH = {
  batchId: 'batch-1',
  summary: 'Refund Dana and tell her.',
  actions: [
    {
      tool: 'jira_refund_payment',
      args: { amount: 240, customer: 'Dana Lin' },
      reason: 'Overcharged',
    },
    { tool: 'outlook_send_mail', args: { to: ['dana@example.com'] }, reason: 'Let her know' },
  ],
};

const QUESTION_FORM = [
  { kind: 'field', name: 'the issue key', label: 'Which issue?', type: 'text', required: true },
];

/** An agent_runs row's columns besides the ones a test names. */
const RUN_DEFAULTS = {
  trigger_id: null,
  triggered_by_subject: null,
  parent_run_id: null,
  lineage: [],
  depth: 0,
  definition_snapshot: null,
  legacy_steps_snapshot: null,
  initial_state: null,
  llm_model_id: null,
  current_step_id: null,
  error: null,
  error_kind: null,
  active_ms: '0',
  started_at: null,
  finished_at: null,
  waiting_until: null,
  cancel_requested_at: null,
  cancel_requested_by: null,
  resume_count: 0,
  resume_failure: null,
  resume_guidance: null,
  resume_step_id: null,
  resumed_at: null,
  resumed_by: null,
  created_at: new Date('2026-08-28T08:00:00.000Z'),
  updated_at: new Date('2026-08-28T08:00:00.000Z'),
};

function card(n: number, extra: Partial<NewRow<'actionable_items'>>): NewRow<'actionable_items'> {
  return {
    id: id(n),
    owner_subject: 'alice',
    source: 'agent',
    kind: 'approval',
    title: 'Refund triage — wants to make 2 changes',
    summary: 'Refund Dana and tell her.',
    run_id: RUN,
    created_by_agent_id: AGENT,
    suggested_action: BATCH,
    evidence: {},
    status: 'suggested',
    result: null,
    created_by: null,
    step_id: null,
    attempt: null,
    iteration: null,
    decided_at: null,
    decided_by: null,
    archived_at: null,
    archived_by: null,
    created_at: new Date('2026-08-28T09:00:00.000Z'),
    updated_at: new Date('2026-08-28T09:00:00.000Z'),
    ...extra,
  };
}

function fixture(cards: NewRow<'actionable_items'>[]): TableRows {
  return {
    agents: [
      { id: AGENT, owner_subject: 'alice', name: 'Refund triage' },
      { id: AGENT_2, owner_subject: 'alice', name: 'Sunday Deep Sweep' },
    ],
    agent_runs: [
      {
        id: RUN,
        agent_id: AGENT,
        owner_subject: 'alice',
        trigger_kind: 'manual',
        status: 'waiting',
        ...RUN_DEFAULTS,
        waiting_until: new Date('2026-08-31T09:00:00.000Z'),
      },
      {
        id: RUN_2,
        agent_id: AGENT_2,
        owner_subject: 'alice',
        trigger_kind: 'manual',
        status: 'waiting',
        ...RUN_DEFAULTS,
      },
    ],
    actionable_items: cards,
  };
}

function storedCard(cardId: string) {
  return store.tables.first('actionable_items', (row) => row.id === cardId);
}

/** The store, except that every claim loses — someone decided in between. */
function losingClaims() {
  registerDataStore({
    ...store,
    agentRuns: { ...store.agentRuns, claimCard: async () => false },
  });
}

beforeEach(() => {
  store.reset();
  registerDataStore(store);
});

afterAll(() => {
  resetDataStore();
});

describe('listPendingApprovals', () => {
  it('reads the staged batch the engine recorded on the card, in order', async () => {
    await store.seed(
      fixture([
        card(21, {}),
        card(23, { suggested_action: {}, created_at: new Date('2026-08-29T09:00:00.000Z') }),
      ])
    );
    const [approval, empty] = await listPendingApprovals('alice');
    expect(approval?.summary).toBe('Refund Dana and tell her.');
    expect(approval?.agentName).toBe('Refund triage');
    expect(approval?.waitingUntil).toBe('2026-08-31T09:00:00.000Z');
    expect(approval?.actions.map((action) => action.tool)).toEqual([
      'jira_refund_payment',
      'outlook_send_mail',
    ]);
    expect(approval?.actions[0]?.args).toEqual({ amount: 240, customer: 'Dana Lin' });
    expect(empty?.actions).toEqual([]);
  });

  it('scopes to the caller and to undecided cards', async () => {
    await store.seed(
      fixture([
        card(21, {}),
        card(23, { owner_subject: 'bob' }),
        card(24, { status: 'approved' }),
        card(25, { kind: 'question' }),
      ])
    );
    // Owner-scoped by construction: someone else's approval must not be
    // listed, because it must not be decidable either.
    expect((await listPendingApprovals('alice')).map((row) => row.cardId)).toEqual([CARD]);
    expect(await listPendingApprovals('carol')).toEqual([]);
  });

  it('drops a card whose run is gone rather than offering an undecidable one', async () => {
    await store.seed(fixture([card(21, { run_id: null })]));
    expect(await listPendingApprovals('alice')).toEqual([]);
  });
});

describe('decideApproval', () => {
  it('refuses a card that is not this caller’s', async () => {
    await store.seed(fixture([card(21, { owner_subject: 'bob' })]));
    const result = await decideApproval(producer(true), 'alice', {
      cardId: CARD,
      decision: 'approve',
    });
    expect(result.outcome).toBe('not-found');
  });

  it('refuses an ordinary card, and one already decided', async () => {
    await store.seed(
      fixture([card(21, { kind: 'info', run_id: null }), card(23, { status: 'expired' })])
    );
    const info = await decideApproval(producer(true), 'alice', {
      cardId: CARD,
      decision: 'approve',
    });
    expect(info.outcome).toBe('not-approval');

    const done = await decideApproval(producer(true), 'alice', {
      cardId: id(23),
      decision: 'approve',
    });
    expect(done).toEqual({ outcome: 'already-decided', status: 'expired' });
  });

  it('loses the race rather than overwriting a decision that already stands', async () => {
    // The card passed the read, then the claim updated nothing: someone
    // decided, or the sweep expired it, in between.
    await store.seed(fixture([card(21, {})]));
    losingClaims();
    const result = await decideApproval(producer(true), 'alice', {
      cardId: CARD,
      decision: 'approve',
    });
    expect(result.outcome).toBe('already-decided');
    expect(storedCard(CARD)?.status).toBe('suggested');
  });

  it('calls a decision decided even when the wake was lost', async () => {
    // The claim is durable and the approval sweep resumes the run. Reporting
    // failure here would have the caller decide twice.
    await store.seed(fixture([card(21, {})]));
    const result = await decideApproval(producer(false), 'alice', {
      cardId: CARD,
      decision: 'decline',
    });
    expect(result).toEqual({ outcome: 'decided', decision: 'decline', runId: RUN, resumed: false });
    expect(storedCard(CARD)).toMatchObject({ status: 'declined', decided_by: 'alice' });
    expect(storedCard(CARD)?.archived_at).toBeInstanceOf(Date);
  });

  it('records a comment alongside the decision, and wakes the run', async () => {
    await store.seed(fixture([card(21, {})]));
    const result = await decideApproval(producer(true), 'alice', {
      cardId: CARD,
      decision: 'decline',
      comment: 'wrong ticket',
    });
    expect(result).toMatchObject({ outcome: 'decided', resumed: true });
    expect(storedCard(CARD)?.result).toEqual({ comment: 'wrong ticket', decidedBy: 'alice' });
  });

  it('refuses a comment past the cap before claiming anything', async () => {
    await store.seed(fixture([card(21, {})]));
    const result = await decideApproval(producer(true), 'alice', {
      cardId: CARD,
      decision: 'approve',
      comment: 'x'.repeat(10_001),
    });
    expect(result.outcome).toBe('comment-too-long');
    // Nothing was written: an over-long comment must not half-decide.
    expect(storedCard(CARD)?.status).toBe('suggested');
  });
});

const questionCard = (extra: Partial<NewRow<'actionable_items'>> = {}) =>
  card(22, {
    kind: 'question',
    title: 'Sunday Deep Sweep — has a question',
    run_id: RUN_2,
    created_by_agent_id: AGENT_2,
    suggested_action: { message: 'Which issue tracks this?', form: QUESTION_FORM },
    ...extra,
  });

describe('listPendingQuestions', () => {
  it('reads the message and form the engine recorded on the card', async () => {
    await store.seed(fixture([questionCard()]));
    const [question] = await listPendingQuestions('alice');
    expect(question?.message).toBe('Which issue tracks this?');
    expect(question?.form).toEqual(QUESTION_FORM);
    expect(question?.agentName).toBe('Sunday Deep Sweep');
  });

  it('scopes to the caller and to undecided cards', async () => {
    await store.seed(
      fixture([questionCard(), card(23, { kind: 'question', status: 'answered' }), card(24, {})])
    );
    expect((await listPendingQuestions('alice')).map((row) => row.cardId)).toEqual([QUESTION]);
    expect(await listPendingQuestions('bob')).toEqual([]);
  });

  it('drops a card whose run is gone rather than offering an undecidable one', async () => {
    await store.seed(fixture([questionCard({ run_id: null })]));
    expect(await listPendingQuestions('alice')).toEqual([]);
  });
});

describe('answerQuestion', () => {
  const FORM = [
    {
      kind: 'field',
      name: 'the issue key',
      label: 'Which issue?',
      type: 'text' as const,
      required: true,
    },
    {
      kind: 'field',
      name: 'the points',
      label: 'Points',
      type: 'number' as const,
      required: false,
      min: 1,
      max: 13,
    },
    {
      kind: 'group',
      label: 'Extra',
      nodes: [
        {
          kind: 'field',
          name: 'the comments',
          label: 'Which comments?',
          type: 'multi' as const,
          required: false,
          options: ['decision 1', 'risk 2'],
        },
      ],
    },
  ];
  const formCard = () =>
    questionCard({
      suggested_action: { message: 'Which issue tracks this?', form: FORM },
    });

  it('refuses a card that is not this caller’s', async () => {
    await store.seed(fixture([formCard()]));
    const result = await answerQuestion(producer(true), 'bob', { cardId: QUESTION, answers: {} });
    expect(result.outcome).toBe('not-found');
  });

  it('refuses an ordinary card, and one already decided', async () => {
    await store.seed(
      fixture([card(21, { kind: 'info', run_id: null }), questionCard({ status: 'expired' })])
    );
    const info = await answerQuestion(producer(true), 'alice', { cardId: CARD, answers: {} });
    expect(info.outcome).toBe('not-question');

    const done = await answerQuestion(producer(true), 'alice', { cardId: QUESTION, answers: {} });
    expect(done).toEqual({ outcome: 'already-decided', status: 'expired' });
  });

  it('refuses answers the form does not accept, and records nothing', async () => {
    await store.seed(fixture([formCard()]));
    const result = await answerQuestion(producer(true), 'alice', {
      cardId: QUESTION,
      answers: { 'the issue key': '', 'the points': 'eight', 'the comments': ['risk 9'] },
    });

    expect(result.outcome).toBe('invalid-answers');
    if (result.outcome !== 'invalid-answers') throw new Error('expected invalid-answers');
    expect(result.issues.map((issue) => issue.label)).toEqual([
      'Which issue?',
      'Points',
      'Which comments?',
    ]);
    // The claim is what makes an answer real; a rejected form must not
    // have made one.
    expect(storedCard(QUESTION)?.status).toBe('suggested');
  });

  it('stores the answers under the same names they arrived with', async () => {
    await store.seed(fixture([formCard()]));
    const result = await answerQuestion(producer(true), 'alice', {
      cardId: QUESTION,
      answers: { 'the issue key': 'CIO-12', 'the points': ' 8 ', 'the comments': ['risk 2'] },
    });

    expect(result).toEqual({ outcome: 'answered', runId: RUN_2, resumed: true });
    // The reply IS the key/value pairs: what is stored reads the same as
    // what was sent, and as what the run will bind.
    expect(storedCard(QUESTION)?.result).toEqual({
      answers: { 'the issue key': 'CIO-12', 'the points': '8', 'the comments': ['risk 2'] },
      decidedBy: 'alice',
    });
  });

  it('loses the race rather than overwriting an answer that already stands', async () => {
    await store.seed(fixture([formCard()]));
    losingClaims();
    const result = await answerQuestion(producer(true), 'alice', {
      cardId: QUESTION,
      answers: { 'the issue key': 'CIO-12' },
    });
    expect(result.outcome).toBe('already-decided');
  });
});

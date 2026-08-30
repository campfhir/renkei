/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The claim semantics the web feed and the MCP tools now share. What is
 * pinned here is the part that must not drift between them: who may decide,
 * who wins a race, and what a lost wake is allowed to be called.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import {
  answerQuestion,
  decideApproval,
  listPendingApprovals,
  listPendingQuestions,
} from './approvals';

/** A kysely stub recording the WHERE terms each chain accumulated. */
function stubDb(options: {
  rows?: unknown[];
  row?: unknown;
  updated?: number;
  wheres?: [string, unknown][];
  /** Every `.set({...})` the call made, in order. */
  sets?: Record<string, unknown>[];
}): Kysely<DB> {
  const chain = {
    selectFrom: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    updateTable: () => chain,
    select: () => chain,
    set: (values: Record<string, unknown>) => {
      options.sets?.push(values);
      return chain;
    },
    orderBy: () => chain,
    limit: () => chain,
    where: (column: string, _op?: unknown, value?: unknown) => {
      options.wheres?.push([column, value]);
      return chain;
    },
    execute: async () => options.rows ?? [],
    executeTakeFirst: async () =>
      options.updated === undefined
        ? options.row
        : { numUpdatedRows: BigInt(options.updated), ...(options.row ?? {}) },
  };
  return chain as unknown as Kysely<DB>;
}

const producer = (ok: boolean): QueueProducer =>
  ({ enqueue: async () => ({ ok }) }) as unknown as QueueProducer;

const CARD_ROW = {
  cardId: 'card-1',
  runId: 'run-1',
  title: 'Refund triage — needs your approval',
  summary: 'Wants to call Refund payment.',
  suggestedAction: { tool: 'jira_refund_payment', args: { amount: 240, customer: 'Dana Lin' } },
  createdAt: new Date('2026-08-28T09:00:00.000Z'),
  agentId: 'agent-1',
  agentName: 'Refund triage',
  waitingUntil: new Date('2026-08-31T09:00:00.000Z'),
};

describe('listPendingApprovals', () => {
  it('reads the proposed call the engine recorded on the card', async () => {
    const [approval] = await listPendingApprovals(stubDb({ rows: [CARD_ROW] }), 't', 'alice');
    expect(approval?.proposedTool).toBe('jira_refund_payment');
    expect(approval?.proposedArgs).toEqual({ amount: 240, customer: 'Dana Lin' });

    const [empty] = await listPendingApprovals(
      stubDb({ rows: [{ ...CARD_ROW, suggestedAction: {} }] }),
      't',
      'alice'
    );
    expect(empty?.proposedTool).toBeNull();
    expect(empty?.proposedArgs).toBeNull();
  });

  it('scopes to the caller and to undecided cards', async () => {
    const wheres: [string, unknown][] = [];
    await listPendingApprovals(stubDb({ rows: [], wheres }), 'tenant-1', 'alice');

    // Owner-scoped by construction: someone else's approval must not be
    // listed, because it must not be decidable either.
    expect(wheres).toContainEqual(['c.owner_subject', 'alice']);
    expect(wheres).toContainEqual(['c.kind', 'approval']);
    expect(wheres).toContainEqual(['c.status', 'suggested']);
  });

  it('drops a card whose run is gone rather than offering an undecidable one', async () => {
    const rows = await listPendingApprovals(
      stubDb({ rows: [{ ...CARD_ROW, runId: null }] }),
      't',
      'alice'
    );
    expect(rows).toEqual([]);
  });
});

describe('decideApproval', () => {
  it('refuses a card that is not this caller’s', async () => {
    const result = await decideApproval(stubDb({ row: undefined }), producer(true), 't', 'alice', {
      cardId: 'card-1',
      decision: 'approve',
    });
    expect(result.outcome).toBe('not-found');
  });

  it('refuses an ordinary card, and one already decided', async () => {
    const info = await decideApproval(
      stubDb({ row: { id: 'c', kind: 'info', status: 'suggested', run_id: null } }),
      producer(true),
      't',
      'alice',
      { cardId: 'c', decision: 'approve' }
    );
    expect(info.outcome).toBe('not-approval');

    const done = await decideApproval(
      stubDb({ row: { id: 'c', kind: 'approval', status: 'expired', run_id: 'run-1' } }),
      producer(true),
      't',
      'alice',
      { cardId: 'c', decision: 'approve' }
    );
    expect(done).toEqual({ outcome: 'already-decided', status: 'expired' });
  });

  it('loses the race rather than overwriting a decision that already stands', async () => {
    // The card passed the read, then the claim updated nothing: someone
    // decided, or the sweep expired it, in between.
    const result = await decideApproval(
      stubDb({
        row: { id: 'c', kind: 'approval', status: 'suggested', run_id: 'run-1' },
        updated: 0,
      }),
      producer(true),
      't',
      'alice',
      { cardId: 'c', decision: 'approve' }
    );
    expect(result.outcome).toBe('already-decided');
  });

  it('calls a decision decided even when the wake was lost', async () => {
    // The claim is durable and the approval sweep resumes the run. Reporting
    // failure here would have the caller decide twice.
    const result = await decideApproval(
      stubDb({
        row: { id: 'c', kind: 'approval', status: 'suggested', run_id: 'run-1' },
        updated: 1,
      }),
      producer(false),
      't',
      'alice',
      { cardId: 'c', decision: 'decline' }
    );
    expect(result).toEqual({
      outcome: 'decided',
      decision: 'decline',
      runId: 'run-1',
      resumed: false,
    });
  });

  it('records a comment alongside the decision', async () => {
    const sets: Record<string, unknown>[] = [];
    await decideApproval(
      stubDb({
        row: { id: 'c', kind: 'approval', status: 'suggested', run_id: 'run-1' },
        updated: 1,
        sets,
      }),
      producer(true),
      't',
      'alice',
      { cardId: 'c', decision: 'decline', comment: 'wrong ticket' }
    );
    const stored: { comment?: string } = JSON.parse(String(sets[0]?.result));
    expect(stored.comment).toBe('wrong ticket');
  });

  it('refuses a comment past the cap before claiming anything', async () => {
    const wheres: [string, unknown][] = [];
    const result = await decideApproval(stubDb({ wheres }), producer(true), 't', 'alice', {
      cardId: 'c',
      decision: 'approve',
      comment: 'x'.repeat(10_001),
    });
    expect(result.outcome).toBe('comment-too-long');
    // Nothing was read or written: an over-long comment must not half-decide.
    expect(wheres).toEqual([]);
  });
});

const QUESTION_ROW = {
  cardId: 'card-2',
  runId: 'run-2',
  title: 'Sunday Deep Sweep — has a question',
  suggestedAction: {
    message: 'Which issue tracks this?',
    form: [
      { kind: 'field', name: 'the issue key', label: 'Which issue?', type: 'text', required: true },
    ],
  },
  createdAt: new Date('2026-08-28T09:00:00.000Z'),
  agentId: 'agent-2',
  agentName: 'Sunday Deep Sweep',
  waitingUntil: new Date('2026-08-31T09:00:00.000Z'),
};

describe('listPendingQuestions', () => {
  it('reads the message and form the engine recorded on the card', async () => {
    const [question] = await listPendingQuestions(stubDb({ rows: [QUESTION_ROW] }), 't', 'alice');
    expect(question?.message).toBe('Which issue tracks this?');
    expect(question?.form).toEqual(QUESTION_ROW.suggestedAction.form);
  });

  it('scopes to the caller and to undecided cards', async () => {
    const wheres: [string, unknown][] = [];
    await listPendingQuestions(stubDb({ rows: [], wheres }), 'tenant-1', 'alice');
    expect(wheres).toContainEqual(['c.owner_subject', 'alice']);
    expect(wheres).toContainEqual(['c.kind', 'question']);
    expect(wheres).toContainEqual(['c.status', 'suggested']);
  });

  it('drops a card whose run is gone rather than offering an undecidable one', async () => {
    const rows = await listPendingQuestions(
      stubDb({ rows: [{ ...QUESTION_ROW, runId: null }] }),
      't',
      'alice'
    );
    expect(rows).toEqual([]);
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
  const questionCard = (extra: Record<string, unknown> = {}) => ({
    id: 'card-2',
    kind: 'question',
    status: 'suggested',
    run_id: 'run-2',
    suggested_action: { message: 'Which issue tracks this?', form: FORM },
    ...extra,
  });

  it('refuses a card that is not this caller’s', async () => {
    const result = await answerQuestion(stubDb({ row: undefined }), producer(true), 't', 'alice', {
      cardId: 'card-2',
      answers: {},
    });
    expect(result.outcome).toBe('not-found');
  });

  it('refuses an ordinary card, and one already decided', async () => {
    const info = await answerQuestion(
      stubDb({ row: { id: 'c', kind: 'info', status: 'suggested', run_id: null } }),
      producer(true),
      't',
      'alice',
      { cardId: 'c', answers: {} }
    );
    expect(info.outcome).toBe('not-question');

    const done = await answerQuestion(
      stubDb({ row: { id: 'c', kind: 'question', status: 'expired', run_id: 'run-1' } }),
      producer(true),
      't',
      'alice',
      { cardId: 'c', answers: {} }
    );
    expect(done).toEqual({ outcome: 'already-decided', status: 'expired' });
  });

  it('refuses answers the form does not accept, and records nothing', async () => {
    const sets: Record<string, unknown>[] = [];
    const result = await answerQuestion(
      stubDb({ row: questionCard(), updated: 1, sets }),
      producer(true),
      't',
      'alice',
      {
        cardId: 'card-2',
        answers: { 'the issue key': '', 'the points': 'eight', 'the comments': ['risk 9'] },
      }
    );

    expect(result.outcome).toBe('invalid-answers');
    if (result.outcome !== 'invalid-answers') throw new Error('expected invalid-answers');
    expect(result.issues.map((issue) => issue.label)).toEqual([
      'Which issue?',
      'Points',
      'Which comments?',
    ]);
    // The claim is what makes an answer real; a rejected form must not
    // have made one.
    expect(sets).toHaveLength(0);
  });

  it('stores the answers under the same names they arrived with', async () => {
    const sets: Record<string, unknown>[] = [];
    const result = await answerQuestion(
      stubDb({ row: questionCard(), updated: 1, sets }),
      producer(true),
      't',
      'alice',
      {
        cardId: 'card-2',
        answers: { 'the issue key': 'CIO-12', 'the points': ' 8 ', 'the comments': ['risk 2'] },
      }
    );

    expect(result.outcome).toBe('answered');
    const stored: { answers?: Record<string, unknown> } = JSON.parse(String(sets[0]?.result));
    // The reply IS the key/value pairs: what is stored reads the same as
    // what was sent, and as what the run will bind.
    expect(stored.answers).toEqual({
      'the issue key': 'CIO-12',
      'the points': '8',
      'the comments': ['risk 2'],
    });
  });

  it('loses the race rather than overwriting an answer that already stands', async () => {
    const result = await answerQuestion(
      stubDb({ row: questionCard(), updated: 0 }),
      producer(true),
      't',
      'alice',
      { cardId: 'card-2', answers: { 'the issue key': 'CIO-12' } }
    );
    expect(result.outcome).toBe('already-decided');
  });
});

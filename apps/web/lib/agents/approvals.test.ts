/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The claim semantics the web feed and the MCP tools now share. What is
 * pinned here is the part that must not drift between them: who may decide,
 * who wins a race, and what a lost wake is allowed to be called.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { decideApproval, listPendingApprovals } from './approvals';

/** A kysely stub recording the WHERE terms each chain accumulated. */
function stubDb(options: {
  rows?: unknown[];
  row?: unknown;
  updated?: number;
  wheres?: [string, unknown][];
}): Kysely<DB> {
  const chain = {
    selectFrom: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    updateTable: () => chain,
    select: () => chain,
    set: () => chain,
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
  summary: 'Refund $240 to Dana Lin?',
  suggestedAction: { approvalMode: 'input' },
  createdAt: new Date('2026-08-28T09:00:00.000Z'),
  agentId: 'agent-1',
  agentName: 'Refund triage',
  waitingUntil: new Date('2026-08-31T09:00:00.000Z'),
};

describe('listPendingApprovals', () => {
  it('reads the mode the engine recorded on the card', async () => {
    const [input] = await listPendingApprovals(stubDb({ rows: [CARD_ROW] }), 't', 'alice');
    expect(input?.mode).toBe('input');

    const [verdict] = await listPendingApprovals(
      stubDb({ rows: [{ ...CARD_ROW, suggestedAction: {} }] }),
      't',
      'alice'
    );
    // A card with no mode recorded wants a verdict — the safer default,
    // since an answer box for a yes/no is a worse wrong guess than the
    // reverse.
    expect(verdict?.mode).toBe('approve');
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

  it('refuses an answer past the cap before claiming anything', async () => {
    const wheres: [string, unknown][] = [];
    const result = await decideApproval(stubDb({ wheres }), producer(true), 't', 'alice', {
      cardId: 'c',
      decision: 'approve',
      answer: 'x'.repeat(10_001),
    });
    expect(result.outcome).toBe('answer-too-long');
    // Nothing was read or written: an over-long answer must not half-decide.
    expect(wheres).toEqual([]);
  });
});

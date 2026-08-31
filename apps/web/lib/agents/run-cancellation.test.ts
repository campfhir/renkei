/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * What must hold, independent of the caller (route or MCP tool): a run
 * that already finished refuses; the flag is a one-way claim, not a
 * repeatable write; and only a queued/waiting run gets woken — a running
 * one already has its own executor watching for the flag (engine.ts).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { requestRunCancellation } from './run-cancellation';

function stubDb(options: {
  row?: unknown;
  updated?: number;
  wheres?: [string, unknown][];
  sets?: Record<string, unknown>[];
}): Kysely<DB> {
  const chain = {
    selectFrom: () => chain,
    updateTable: () => chain,
    select: () => chain,
    set: (values: Record<string, unknown>) => {
      options.sets?.push(values);
      return chain;
    },
    where: (column: string, _op?: unknown, value?: unknown) => {
      options.wheres?.push([column, value]);
      return chain;
    },
    executeTakeFirst: async () =>
      options.updated === undefined
        ? options.row
        : { numUpdatedRows: BigInt(options.updated), ...(options.row ?? {}) },
  };
  return chain as unknown as Kysely<DB>;
}

const input = {
  tenantId: 't',
  agentId: 'agent-1',
  runId: 'run-1',
  ownerSubject: 'alice',
  canceledBySubject: 'alice',
};

describe('requestRunCancellation', () => {
  it('reports not-found for a run that is not this owner’s', async () => {
    const result = await requestRunCancellation(
      stubDb({ row: undefined }),
      { enqueue: async () => ({ ok: true }) } as unknown as QueueProducer,
      input
    );
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('refuses a run that already reached a terminal status', async () => {
    const enqueue = jest.fn();
    const result = await requestRunCancellation(
      stubDb({ row: { id: 'run-1', status: 'succeeded' } }),
      { enqueue } as unknown as QueueProducer,
      input
    );
    expect(result).toEqual({ outcome: 'already-final', status: 'succeeded' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('claims a queued run and wakes a worker for it', async () => {
    const enqueue = jest.fn(async () => ({ ok: true }));
    const sets: Record<string, unknown>[] = [];
    const result = await requestRunCancellation(
      stubDb({ row: { id: 'run-1', status: 'queued' }, updated: 1, sets }),
      { enqueue } as unknown as QueueProducer,
      input
    );
    expect(result).toEqual({ outcome: 'canceling' });
    expect(sets[0]).toMatchObject({ cancel_requested_by: 'alice' });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'run',
        payload: { runId: 'run-1' },
        orderingKey: 'agent:agent-1',
      })
    );
  });

  it('claims a waiting run and wakes a worker for it too', async () => {
    const enqueue = jest.fn(async () => ({ ok: true }));
    const result = await requestRunCancellation(
      stubDb({ row: { id: 'run-1', status: 'waiting' }, updated: 1 }),
      { enqueue } as unknown as QueueProducer,
      input
    );
    expect(result).toEqual({ outcome: 'canceling' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('claims a running run WITHOUT enqueuing — its own executor is already watching', async () => {
    const enqueue = jest.fn();
    const result = await requestRunCancellation(
      stubDb({ row: { id: 'run-1', status: 'running' }, updated: 1 }),
      { enqueue } as unknown as QueueProducer,
      input
    );
    expect(result).toEqual({ outcome: 'canceling' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a lost claim (already requested, or finished in the gap) is still "canceling", not an error', async () => {
    const enqueue = jest.fn();
    const result = await requestRunCancellation(
      stubDb({ row: { id: 'run-1', status: 'running' }, updated: 0 }),
      { enqueue } as unknown as QueueProducer,
      input
    );
    expect(result).toEqual({ outcome: 'canceling' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * What must hold: a run that already finished refuses; the status flip is a
 * one-way claim guarded the same way requestRunCancellation's is (a race in
 * the gap between the read and the write is "already-final", not a crash);
 * and a successful halt also clears the run's agent_jobs row so nothing can
 * reclaim or resume it afterward.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { forceHaltRun } from './force-halt';

jest.mock('@renkei/agents/runs', () => ({
  recordAgentRunOutcome: jest.fn(async () => ({ ok: true })),
}));

function stubDb(options: {
  row?: unknown;
  updated?: number;
  calls?: { table: string; op: 'select' | 'update' | 'delete' }[];
  sets?: Record<string, unknown>[];
}): Kysely<DB> {
  let currentTable = '';
  let currentOp: 'select' | 'update' | 'delete' = 'select';
  const chain = {
    selectFrom: (table: string) => {
      currentTable = table;
      currentOp = 'select';
      options.calls?.push({ table, op: 'select' });
      return chain;
    },
    updateTable: (table: string) => {
      currentTable = table;
      currentOp = 'update';
      options.calls?.push({ table, op: 'update' });
      return chain;
    },
    deleteFrom: (table: string) => {
      currentTable = table;
      currentOp = 'delete';
      options.calls?.push({ table, op: 'delete' });
      return chain;
    },
    select: () => chain,
    set: (values: Record<string, unknown>) => {
      options.sets?.push({ ...values, __table: currentTable });
      return chain;
    },
    where: () => chain,
    execute: async () => undefined,
    executeTakeFirst: async () => {
      if (
        currentTable === 'agent_runs' &&
        currentOp === 'update' &&
        options.updated !== undefined
      ) {
        return { numUpdatedRows: BigInt(options.updated) };
      }
      return options.row;
    },
  };
  return chain as unknown as Kysely<DB>;
}

const input = {
  tenantId: 't',
  agentId: 'agent-1',
  runId: 'run-1',
  haltedBySubject: 'admin@example.com',
};

describe('forceHaltRun', () => {
  it('reports not-found for a run that does not exist in this tenant/agent', async () => {
    const result = await forceHaltRun(stubDb({ row: undefined }), input);
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('refuses a run that already reached a terminal status', async () => {
    const result = await forceHaltRun(
      stubDb({ row: { id: 'run-1', status: 'succeeded', owner_subject: 'alice' } }),
      input
    );
    expect(result).toEqual({ outcome: 'already-final', status: 'succeeded' });
  });

  it('treats a lost claim (finished in the gap) as already-final, not an error', async () => {
    const result = await forceHaltRun(
      stubDb({ row: { id: 'run-1', status: 'running', owner_subject: 'alice' }, updated: 0 }),
      input
    );
    expect(result).toEqual({ outcome: 'already-final', status: 'running' });
  });

  it('halts a running run and clears its agent_jobs row', async () => {
    const calls: { table: string; op: 'select' | 'update' | 'delete' }[] = [];
    const sets: Record<string, unknown>[] = [];
    const result = await forceHaltRun(
      stubDb({
        row: { id: 'run-1', status: 'running', owner_subject: 'alice' },
        updated: 1,
        calls,
        sets,
      }),
      input
    );
    expect(result).toEqual({ outcome: 'halted' });

    const runUpdate = sets.find((s) => s.__table === 'agent_runs');
    expect(runUpdate).toMatchObject({ status: 'canceled', error_kind: 'force_halted' });

    const jobUpdate = sets.find((s) => s.__table === 'agent_jobs');
    expect(jobUpdate).toMatchObject({ status: 'skipped' });

    expect(calls).toContainEqual({ table: 'agent_jobs_dead_letters', op: 'delete' });
  });
});

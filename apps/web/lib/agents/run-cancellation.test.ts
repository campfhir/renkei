/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * What must hold, independent of the caller (route or MCP tool): a run
 * that already finished refuses; the flag is a one-way claim, not a
 * repeatable write; and only a queued/waiting run gets woken — a running
 * one already has its own executor watching for the flag (engine.ts).
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { requestRunCancellation } from './run-cancellation';

const AGENT = '00000000-0000-4000-8000-000000000a01';
const RUN = '00000000-0000-4000-8000-000000000b01';
const store = createMemoryDataStore();

const input = {
  agentId: AGENT,
  runId: RUN,
  ownerSubject: 'alice',
  canceledBySubject: 'alice',
};

async function seedRun(status: string, extra: Record<string, unknown> = {}) {
  await store.seed({
    agents: [{ id: AGENT, owner_subject: 'alice', name: 'Sweep' }],
    agent_runs: [
      {
        id: RUN,
        agent_id: AGENT,
        owner_subject: 'alice',
        trigger_kind: 'manual',
        status,
        ...extra,
      },
    ],
  });
}

function storedRun() {
  return store.tables.first('agent_runs', (row) => row.id === RUN);
}

beforeEach(() => {
  store.reset();
  registerDataStore(store);
});

afterAll(() => {
  resetDataStore();
});

describe('requestRunCancellation', () => {
  it('reports not-found for a run that is not this owner’s', async () => {
    await seedRun('queued');
    const result = await requestRunCancellation(
      { enqueue: async () => ({ ok: true }) } as unknown as QueueProducer,
      { ...input, ownerSubject: 'mallory' }
    );
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('refuses a run that already reached a terminal status', async () => {
    await seedRun('succeeded');
    const enqueue = jest.fn();
    const result = await requestRunCancellation({ enqueue } as unknown as QueueProducer, input);
    expect(result).toEqual({ outcome: 'already-final', status: 'succeeded' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(storedRun()?.cancel_requested_at).toBeNull();
  });

  it('claims a queued run and wakes a worker for it', async () => {
    await seedRun('queued');
    const enqueue = jest.fn(async () => ({ ok: true }));
    const result = await requestRunCancellation({ enqueue } as unknown as QueueProducer, input);
    expect(result).toEqual({ outcome: 'canceling' });
    expect(storedRun()).toMatchObject({ cancel_requested_by: 'alice' });
    expect(storedRun()?.cancel_requested_at).toBeInstanceOf(Date);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'run',
        payload: { runId: RUN },
        orderingKey: `agent:${AGENT}`,
      })
    );
  });

  it('claims a waiting run and wakes a worker for it too', async () => {
    await seedRun('waiting');
    const enqueue = jest.fn(async () => ({ ok: true }));
    const result = await requestRunCancellation({ enqueue } as unknown as QueueProducer, input);
    expect(result).toEqual({ outcome: 'canceling' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('claims a running run WITHOUT enqueuing — its own executor is already watching', async () => {
    await seedRun('running');
    const enqueue = jest.fn();
    const result = await requestRunCancellation({ enqueue } as unknown as QueueProducer, input);
    expect(result).toEqual({ outcome: 'canceling' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(storedRun()?.cancel_requested_at).toBeInstanceOf(Date);
  });

  it('a lost claim (already requested) is still "canceling", not an error', async () => {
    await seedRun('waiting', {
      cancel_requested_at: '2026-01-01T00:00:00.000Z',
      cancel_requested_by: 'bob',
    });
    const enqueue = jest.fn();
    const result = await requestRunCancellation({ enqueue } as unknown as QueueProducer, input);
    expect(result).toEqual({ outcome: 'canceling' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(storedRun()?.cancel_requested_by).toBe('bob');
  });
});

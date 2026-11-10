/**
 * The dead-run sweep halts what will never finish — a day-old queued or
 * running run, a wait an hour past its deadline, an old wait with no
 * deadline — and leaves everything that still has a way forward alone.
 */

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createDeadRunSweep } from './dead-run-sweep';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(NOW - ms);
const id = (n: number) => `00000000-0000-4000-8000-00000000d${String(n).padStart(3, '0')}`;
const AGENT = id(1);

function run(n: number, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    agent_id: AGENT,
    owner_subject: 'ann',
    trigger_kind: 'schedule',
    status,
    waiting_until: null,
    created_at: ago(30 * HOUR),
    updated_at: ago(30 * HOUR),
    ...extra,
  };
}

beforeEach(async () => {
  const store = createMemoryDataStore();
  await store.seed({
    agents: [{ id: AGENT, owner_subject: 'ann', name: 'Zoom summary' }],
    agent_runs: [
      run(11, 'queued'),
      run(12, 'running', { started_at: ago(29 * HOUR) }),
      run(13, 'waiting', { waiting_until: ago(2 * HOUR) }),
      run(14, 'waiting'),
      // Still has a way forward:
      run(21, 'queued', { created_at: ago(3 * HOUR) }),
      run(22, 'queued', { resumed_at: ago(HOUR) }),
      run(23, 'waiting', { waiting_until: ago(10 * 60_000) }),
      run(24, 'waiting', { waiting_until: new Date(NOW + 48 * HOUR) }),
      run(25, 'succeeded'),
      // Parked until its owner signs in: no deadline, and not dead.
      run(26, 'waiting', { error_kind: 'needs-sign-in' }),
    ],
    agent_jobs: [
      {
        id: id(31),
        source: `agents:${AGENT}`,
        type: 'run',
        payload: { runId: id(11) },
        status: 'pending',
        ordering_key: `agent:${AGENT}`,
        attempts: 0,
        run_after: ago(30 * HOUR),
        locked_at: null,
        last_error: null,
        created_at: ago(30 * HOUR),
      },
    ],
  });
  registerDataStore(store);
});

afterEach(() => resetDataStore());

const statusOf = async (n: number) =>
  (await getDataStore().agentRuns.findCancelState(id(n)))?.status;

test('halts the dead runs, clears their jobs, and leaves the live ones', async () => {
  await createDeadRunSweep(() => NOW)();

  expect(await Promise.all([11, 12, 13, 14].map(statusOf))).toEqual([
    'canceled',
    'canceled',
    'canceled',
    'canceled',
  ]);
  expect(await Promise.all([21, 22, 23, 24, 25, 26].map(statusOf))).toEqual([
    'queued',
    'queued',
    'waiting',
    'waiting',
    'succeeded',
    'waiting',
  ]);
  // It reads as Halted, and nothing is left in the queue to resume it.
  const halted = await getDataStore().agentRuns.findDetail({
    agentId: AGENT,
    runId: id(11),
    ownerSubject: 'ann',
    audience: 'owner',
  });
  expect(halted?.errorKind).toBe('force_halted');
  expect(await getDataStore().queues.listAgentJobs(AGENT, 10)).toEqual([]);
  expect(
    (await getDataStore().agentRuns.findCancelState(id(11)))?.cancelRequestedAt
  ).not.toBeNull();
});

test('a second pass finds nothing more to halt', async () => {
  const sweep = createDeadRunSweep(() => NOW);
  await sweep();
  await sweep();
  expect(await statusOf(21)).toBe('queued');
});

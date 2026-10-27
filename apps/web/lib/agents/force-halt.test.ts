/**
 * What must hold: a run that already finished refuses; the status flip is a
 * one-way claim guarded the same way requestRunCancellation's is (a race in
 * the gap between the read and the write is "already-final", not a crash);
 * and a successful halt also clears the run's agent_jobs row AND closes out
 * its in-progress attempt row (marked canceled, not deleted — see
 * force-halt.ts for why), so nothing can reclaim or resume it afterward and
 * the timeline does not show a "Running" attempt under a Canceled run.
 */

jest.mock('@renkei/agents/runs', () => ({
  recordAgentRunOutcome: jest.fn(async () => ({ ok: true })),
}));
jest.mock('./run-jobs', () => ({ discardRunJobs: jest.fn(async () => undefined) }));
jest.mock('@renkei/db', () => ({
  ...jest.requireActual<object>('@renkei/db'),
  getDatabase: jest.fn(() => ({ ok: true, val: {} })),
}));

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type DataStore,
} from '@renkei/db';
import { forceHaltRun } from './force-halt';

const { discardRunJobs: mockDiscardRunJobs } = jest.requireMock<{ discardRunJobs: jest.Mock }>(
  './run-jobs'
);
const { recordAgentRunOutcome: mockRecordOutcome } = jest.requireMock<{
  recordAgentRunOutcome: jest.Mock;
}>('@renkei/agents/runs');

const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';
const RUN_ID = '00000000-0000-4000-8000-0000000000b1';

const input = {
  agentId: AGENT_ID,
  runId: RUN_ID,
  haltedBySubject: 'admin@example.com',
};

async function storeWith(status: string | null): Promise<DataStore> {
  const store = createMemoryDataStore();
  await store.seed({
    agents: [{ id: AGENT_ID, owner_subject: 'alice', name: 'Stuck agent' }],
    agent_runs:
      status === null
        ? []
        : [
            {
              id: RUN_ID,
              agent_id: AGENT_ID,
              owner_subject: 'alice',
              trigger_kind: 'manual',
              status,
            },
          ],
    agent_run_steps:
      status === null
        ? []
        : [
            {
              id: '00000000-0000-4000-8000-0000000000c1',
              run_id: RUN_ID,
              step_id: 'turn',
              step_index: 0,
              attempt: 1,
              status: 'running',
            },
          ],
  });
  registerDataStore(store);
  return store;
}

async function runOf(store: DataStore) {
  return store.agentRuns.findDetail({
    agentId: AGENT_ID,
    runId: RUN_ID,
    ownerSubject: 'alice',
    audience: 'owner',
  });
}

afterEach(() => {
  resetDataStore();
  jest.clearAllMocks();
});

describe('forceHaltRun', () => {
  it('reports not-found for a run that does not exist in this tenant/agent', async () => {
    await storeWith(null);
    expect(await forceHaltRun(input)).toEqual({ outcome: 'not-found' });
    expect(await forceHaltRun({ ...input, agentId: RUN_ID })).toEqual({ outcome: 'not-found' });
  });

  it('refuses a run that already reached a terminal status', async () => {
    await storeWith('succeeded');
    expect(await forceHaltRun(input)).toEqual({ outcome: 'already-final', status: 'succeeded' });
    expect(mockDiscardRunJobs).not.toHaveBeenCalled();
  });

  it('treats a lost claim (finished in the gap) as already-final, not an error', async () => {
    const store = await storeWith('running');
    registerDataStore({
      ...store,
      agentRuns: { ...store.agentRuns, forceCancel: async () => false },
    });
    expect(await forceHaltRun(input)).toEqual({ outcome: 'already-final', status: 'running' });
    expect(mockDiscardRunJobs).not.toHaveBeenCalled();
  });

  it('halts a running run, closes its attempt and clears its agent_jobs row', async () => {
    const store = await storeWith('running');
    expect(await forceHaltRun(input)).toEqual({ outcome: 'halted' });

    const run = await runOf(store);
    expect(run).toMatchObject({ status: 'canceled', errorKind: 'force_halted' });
    expect(run?.steps.map((step) => step.status)).toEqual(['canceled']);
    expect(mockDiscardRunJobs).toHaveBeenCalledWith(RUN_ID);
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ runId: RUN_ID, ownerSubject: 'alice', status: 'canceled' })
    );
  });
});

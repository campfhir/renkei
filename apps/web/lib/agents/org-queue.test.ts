/**
 * The operator's queue view: the organization's live runs with agent name
 * and owner, and a batch halt that halts what it can and reports the rest.
 */

jest.mock('@renkei/agents/runs', () => ({
  recordAgentRunOutcome: jest.fn(async () => ({ ok: true })),
}));
jest.mock('./run-jobs', () => ({ discardRunJobs: jest.fn(async () => undefined) }));

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { countOrgQueue, haltRunsAsOperator, listOrgQueue } from './org-queue';

const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute));

beforeEach(async () => {
  const store = createMemoryDataStore();
  await store.seed({
    identities: [{ subject: 'ann', email: 'ann@example.test', display_name: 'Ann' }],
    agents: [
      { id: id(1), owner_subject: 'ann', name: 'Triage' },
      { id: id(2), owner_subject: 'bob', name: 'Digest' },
    ],
    agent_runs: [
      {
        id: id(11),
        agent_id: id(1),
        owner_subject: 'ann',
        trigger_kind: 'schedule',
        status: 'queued',
        created_at: at(3),
      },
      {
        id: id(12),
        agent_id: id(2),
        owner_subject: 'bob',
        trigger_kind: 'manual',
        status: 'running',
        created_at: at(1),
        started_at: at(2),
      },
      {
        id: id(13),
        agent_id: id(1),
        owner_subject: 'ann',
        trigger_kind: 'manual',
        status: 'succeeded',
        created_at: at(0),
      },
    ],
  });
  registerDataStore(store);
});

afterEach(() => resetDataStore());

describe('the organization queue', () => {
  it('lists every live run oldest first, with its agent and owner', async () => {
    const runs = await listOrgQueue({ limit: 50, offset: 0 });
    expect(
      runs.map((run) => [run.id, run.agentName, run.ownerEmail ?? run.ownerSubject, run.status])
    ).toEqual([
      [id(12), 'Digest', 'bob', 'running'],
      [id(11), 'Triage', 'ann@example.test', 'queued'],
    ]);
    expect(await countOrgQueue()).toEqual([
      { status: 'queued', count: 1 },
      { status: 'running', count: 1 },
    ]);
  });

  it('a batch halt clears the live runs and reports the finished, mismatched and malformed ones', async () => {
    const result = await haltRunsAsOperator(
      [
        { agentId: id(1), runId: id(11) },
        { agentId: id(2), runId: id(12) },
        { agentId: id(1), runId: id(13) },
        { agentId: id(1), runId: id(12) },
        { agentId: 'nope', runId: 'nope' },
      ],
      'operator'
    );
    expect(result).toEqual({
      halted: [id(11), id(12)],
      refused: [
        { runId: id(13), error: 'This run already succeeded.' },
        { runId: id(12), error: 'Not found.' },
        { runId: 'nope', error: 'Not found.' },
      ],
    });
    expect(await listOrgQueue({ limit: 50, offset: 0 })).toEqual([]);
  });
});

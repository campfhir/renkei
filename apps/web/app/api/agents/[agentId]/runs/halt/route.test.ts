/**
 * Halting stuck runs: only runs queued or running for over two hours,
 * one by id or all of the agent's at once; they end canceled with the
 * owner-side reason, younger, waiting and finished runs are left alone,
 * and another agent's runs are never touched.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/agents/access-grants', () => ({ resolveAgentAccess: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { resolveAgentAccess: mockResolveAgentAccess } = jest.requireMock<{
  resolveAgentAccess: jest.Mock;
}>('@/lib/agents/access-grants');

const AGENT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_AGENT = '00000000-0000-4000-8000-0000000000a2';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HOUR = 60 * 60_000;

function run(n: number, status: string, ageMs: number, agentId = AGENT) {
  const created = new Date(Date.now() - ageMs);
  return {
    id: id(n),
    agent_id: agentId,
    owner_subject: 'alice',
    status,
    trigger_kind: 'schedule',
    error_kind: null,
    error: null,
    created_at: created,
    started_at: status === 'running' ? created : null,
    finished_at: null,
    resume_count: 0,
    resumed_at: null,
    cancel_requested_at: null,
    cancel_requested_by: null,
    initial_state: null,
  };
}

async function seed() {
  const store = createMemoryDataStore();
  await store.seed({
    agents: [
      { id: AGENT, owner_subject: 'alice', name: 'Triage', instructions: 'Go.', tools: [] },
      { id: OTHER_AGENT, owner_subject: 'alice', name: 'Other', instructions: 'Go.', tools: [] },
    ],
    agent_runs: [
      run(1, 'running', 9 * 24 * HOUR), // stuck
      run(2, 'queued', 5 * 24 * HOUR), // stuck
      run(3, 'queued', 3 * HOUR), // stuck
      run(4, 'queued', 30 * 60_000), // young: cancel it instead
      run(5, 'waiting', 30 * HOUR), // waiting on a person: never stuck
      run(6, 'succeeded', 30 * HOUR), // finished
      run(7, 'queued', 5 * 24 * HOUR, OTHER_AGENT), // another agent's
    ],
  });
  registerDataStore(store);
}

function post(body?: unknown) {
  return POST(
    new NextRequest('http://test.local/halt', {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ agentId: AGENT }) }
  );
}

async function statusOf(n: number, agentId = AGENT) {
  const found = await getDataStore().agentRuns.findStatus({ agentId, runId: id(n) });
  return found?.status;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ subject: 'alice' });
  mockResolveAgentAccess.mockResolvedValue({ ownerSubject: 'alice', viewerIsOwner: true });
  await seed();
});
afterEach(() => resetDataStore());

describe('halting stuck runs', () => {
  it('with no run named, halts every stuck run of the agent and nothing else', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const body: { halted: string[] } = await response.json();
    expect([...body.halted].sort()).toEqual([id(1), id(2), id(3)]);
    expect(await Promise.all([1, 2, 3, 4, 5, 6].map((n) => statusOf(n)))).toEqual([
      'canceled',
      'canceled',
      'canceled',
      'queued',
      'waiting',
      'succeeded',
    ]);
    expect(await statusOf(7, OTHER_AGENT)).toBe('queued');
  });

  it('a halted run says why, in its own words', async () => {
    await post({ runId: id(1) });
    const [row] = await getDataStore().agentRuns.list({
      agentId: AGENT,
      ownerSubject: 'alice',
      audience: 'owner',
      status: 'canceled',
      limit: 5,
    });
    expect(row).toMatchObject({ id: id(1), errorKind: 'force_halted' });
    expect(row?.error).toMatch(/stuck and not making progress/);
  });

  it('halts one stuck run by id', async () => {
    const response = await post({ runId: id(2) });
    expect(await response.json()).toEqual({ halted: [id(2)] });
    expect(await statusOf(2)).toBe('canceled');
    expect(await statusOf(1)).toBe('running');
  });

  it('refuses a run that is not stuck yet, and says to cancel it', async () => {
    const response = await post({ runId: id(4) });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/cancel it instead/);
    expect(await statusOf(4)).toBe('queued');
  });

  it('refuses a waiting or finished run', async () => {
    expect((await post({ runId: id(5) })).status).toBe(409);
    expect((await post({ runId: id(6) })).status).toBe(409);
    expect(await statusOf(5)).toBe('waiting');
  });

  it('cannot reach another agent’s run through this agent', async () => {
    expect((await post({ runId: id(7) })).status).toBe(404);
    expect(await statusOf(7, OTHER_AGENT)).toBe('queued');
  });

  it('needs a session and access to the agent', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(401);
    mockResolveAgentAccess.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(404);
  });

  it('a second press finds nothing left to halt', async () => {
    await post();
    expect(await (await post()).json()).toEqual({ halted: [] });
  });
});

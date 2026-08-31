/**
 * The rerun route's own concurrency guard: mirrors the invoke route's,
 * with the carve-out on the OLD run's trigger_kind rather than a fresh
 * one's — an event-triggered run already tolerates several running at
 * once, so rerunning one asks nothing extra; anything else (scheduled,
 * manual, api, chained) gets the same "already in progress?" pause.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/agents/access-grants', () => ({ resolveAgentAccess: jest.fn() }));
jest.mock('@renkei/agents', () => ({ isCurrentStepsDoc: jest.fn(() => true) }));
jest.mock('@renkei/agents/runs', () => ({
  createAgentRun: jest.fn(),
  findInProgressRun: jest.fn(),
}));
jest.mock('@renkei/queue', () => ({ agentJobsQueue: jest.fn(() => ({ producer: {} })) }));

import { NextRequest } from 'next/server';
import { POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { resolveAgentAccess: mockResolveAgentAccess } = jest.requireMock<{
  resolveAgentAccess: jest.Mock;
}>('@/lib/agents/access-grants');
const { createAgentRun: mockCreateAgentRun, findInProgressRun: mockFindInProgressRun } =
  jest.requireMock<{ createAgentRun: jest.Mock; findInProgressRun: jest.Mock }>(
    '@renkei/agents/runs'
  );

const TENANT = 't-1';
const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000002';

const AGENT_ROW = {
  id: AGENT_ID,
  owner_subject: 'alice',
  steps: { version: 1, steps: [] },
  llm_model_id: null,
};

function runRow(triggerKind: string) {
  return {
    id: RUN_ID,
    status: 'succeeded',
    initial_state: null,
    trigger_id: null,
    trigger_kind: triggerKind,
  };
}

/** `agent_runs` resolves the old run, `agents` the target agent. */
function stubDb(oldRun: unknown) {
  function chainOf(row: unknown) {
    const self = {
      where: () => self,
      executeTakeFirst: async () => row,
    };
    return self;
  }
  const chain = {
    selectFrom: (table: string) => ({
      select: () => chainOf(table === 'agent_runs' ? oldRun : AGENT_ROW),
    }),
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: chain });
}

function request(body: unknown): NextRequest {
  return new NextRequest('http://test.local/rerun', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function params() {
  return { params: Promise.resolve({ tenantId: TENANT, agentId: AGENT_ID, runId: RUN_ID }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ subject: 'alice' });
  mockResolveAgentAccess.mockResolvedValue({ ownerSubject: 'alice', viewerIsOwner: true });
  mockCreateAgentRun.mockResolvedValue({ ok: true, val: { runId: 'new-run' } });
  mockFindInProgressRun.mockResolvedValue(null);
});

describe('POST rerun — concurrency guard', () => {
  it('refuses a scheduled run’s rerun when another run is already in progress', async () => {
    stubDb(runRow('schedule'));
    mockFindInProgressRun.mockResolvedValue({ id: 'run-3', status: 'running' });

    const response = await POST(request({}), params());

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'already-in-progress', runId: 'run-3', status: 'running' });
    expect(mockCreateAgentRun).not.toHaveBeenCalled();
  });

  it('skips the check entirely for an event-triggered run — it already tolerates concurrency', async () => {
    stubDb(runRow('event'));
    mockFindInProgressRun.mockResolvedValue({ id: 'run-3', status: 'running' });

    const response = await POST(request({}), params());

    expect(response.status).toBe(200);
    expect(mockFindInProgressRun).not.toHaveBeenCalled();
    expect(mockCreateAgentRun).toHaveBeenCalledTimes(1);
  });

  it('proceeds for a scheduled run once confirm: true is sent', async () => {
    stubDb(runRow('schedule'));
    mockFindInProgressRun.mockResolvedValue({ id: 'run-3', status: 'running' });

    const response = await POST(request({ confirm: true }), params());

    expect(response.status).toBe(200);
    expect(mockFindInProgressRun).not.toHaveBeenCalled();
    expect(mockCreateAgentRun).toHaveBeenCalledTimes(1);
  });

  it('proceeds for a manual run when nothing else is in progress', async () => {
    stubDb(runRow('manual'));

    const response = await POST(request({}), params());

    expect(response.status).toBe(200);
    expect(mockCreateAgentRun).toHaveBeenCalledTimes(1);
  });
});

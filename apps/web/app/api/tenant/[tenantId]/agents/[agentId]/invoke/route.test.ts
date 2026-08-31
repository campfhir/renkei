/**
 * The "Run now" button's own guard: a manual (session) invoke with an
 * existing queued/running run for the agent refuses with a distinguishable
 * 409 instead of silently queuing a second one — until the caller resends
 * with confirm:true, at which point it behaves exactly as before. A
 * machine caller (API key) never sees this at all, confirm or not.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/agents/access-grants', () => ({ hasActiveGrant: jest.fn(async () => false) }));
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
const { createAgentRun: mockCreateAgentRun, findInProgressRun: mockFindInProgressRun } =
  jest.requireMock<{ createAgentRun: jest.Mock; findInProgressRun: jest.Mock }>(
    '@renkei/agents/runs'
  );

const TENANT = 't-1';
const AGENT_ID = '00000000-0000-4000-8000-000000000001';

const AGENT_ROW = {
  id: AGENT_ID,
  owner_subject: 'alice',
  name: 'Portfolio Updater',
  steps: { version: 1, steps: [] },
  llm_model_id: null,
  enabled: true,
};

/** `agents` is the only table this route still reads directly. */
function stubDb() {
  const chain = {
    selectFrom: (table: string) => {
      const row = table === 'agents' ? AGENT_ROW : undefined;
      return {
        select: () => ({
          where: () => ({
            where: () => ({ executeTakeFirst: async () => row }),
          }),
        }),
      };
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: chain });
}

function request(body: unknown): NextRequest {
  return new NextRequest('http://test.local/invoke', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function params() {
  return { params: Promise.resolve({ tenantId: TENANT, agentId: AGENT_ID }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  stubDb();
  mockGetSession.mockResolvedValue({ subject: 'alice' });
  mockCreateAgentRun.mockResolvedValue({ ok: true, val: { runId: 'new-run' } });
  mockFindInProgressRun.mockResolvedValue(null);
});

describe('POST invoke — manual concurrency guard', () => {
  it('refuses with already-in-progress when a run is queued or running, and never calls createAgentRun', async () => {
    mockFindInProgressRun.mockResolvedValue({ id: 'run-1', status: 'running' });
    const response = await POST(request({}), params());
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'already-in-progress', runId: 'run-1', status: 'running' });
    expect(mockCreateAgentRun).not.toHaveBeenCalled();
  });

  it('proceeds normally when nothing is in progress', async () => {
    const response = await POST(request({}), params());
    expect(response.status).toBe(202);
    expect(mockCreateAgentRun).toHaveBeenCalledTimes(1);
  });

  it('proceeds once confirm:true is sent, without re-checking', async () => {
    mockFindInProgressRun.mockResolvedValue({ id: 'run-1', status: 'running' });
    const response = await POST(request({ confirm: true }), params());
    expect(response.status).toBe(202);
    expect(mockCreateAgentRun).toHaveBeenCalledTimes(1);
    expect(mockFindInProgressRun).not.toHaveBeenCalled();
  });
});

/**
 * The "Run now" button's own guard: a manual (session) invoke with an
 * existing queued/running run for the agent refuses with a distinguishable
 * 409 instead of silently queuing a second one — until the caller resends
 * with confirm:true, at which point it behaves exactly as before. A
 * machine caller (API key) never sees this at all, confirm or not.
 */

jest.mock('@renkei/db', () => ({
  ...jest.requireActual<object>('@renkei/db'),
  getDatabase: jest.fn(() => ({ ok: true, val: {} })),
}));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/agents/access-grants', () => ({ hasActiveGrant: jest.fn(async () => false) }));
jest.mock('@renkei/agents/runs', () => ({
  createAgentRun: jest.fn(),
  findInProgressRun: jest.fn(),
}));
jest.mock('@renkei/queue', () => ({ agentJobsQueue: jest.fn(() => ({ producer: {} })) }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { createAgentRun: mockCreateAgentRun, findInProgressRun: mockFindInProgressRun } =
  jest.requireMock<{ createAgentRun: jest.Mock; findInProgressRun: jest.Mock }>(
    '@renkei/agents/runs'
  );
const AGENT_ID = '00000000-0000-4000-8000-000000000001';

/** The agent this route reads through the data store. */
async function seedStore() {
  const store = createMemoryDataStore();
  await store.seed({
    agents: [
      {
        id: AGENT_ID,
        owner_subject: 'alice',
        name: 'Portfolio Updater',
        instructions: '## Goal\n\nGo.',
        tools: JSON.stringify([]),
        llm_model_id: null,
        enabled: true,
      },
    ],
  });
  registerDataStore(store);
}

function request(body: unknown): NextRequest {
  return new NextRequest('http://test.local/invoke', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

afterEach(() => resetDataStore());

beforeEach(async () => {
  jest.clearAllMocks();
  await seedStore();
  mockGetSession.mockResolvedValue({ subject: 'alice' });
  mockCreateAgentRun.mockResolvedValue({ ok: true, val: { runId: 'new-run' } });
  mockFindInProgressRun.mockResolvedValue(null);
});

function params() {
  return { params: Promise.resolve({ agentId: AGENT_ID }) };
}

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

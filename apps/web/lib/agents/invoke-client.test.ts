/**
 * The one thing this module exists to get right: a 409 tagged
 * "already-in-progress" becomes a confirm step, never a plain error —
 * that's the whole difference between a modal asking "queue anyway?" and
 * a red error banner.
 */

import { invokeAgentRun, rerunAgentRun } from './invoke-client';

function mockFetch(status: number, body: unknown) {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    void init;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double for the global fetch
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('invokeAgentRun', () => {
  it('reports started with the new run id on success', async () => {
    mockFetch(202, { runId: 'run-1' });
    const result = await invokeAgentRun('tenant-1', 'agent-1');
    expect(result).toEqual({ kind: 'started', runId: 'run-1' });
  });

  it('turns an already-in-progress 409 into needs-confirm, not error', async () => {
    mockFetch(409, {
      error: 'A run of this agent is already running.',
      code: 'already-in-progress',
      runId: 'run-1',
      status: 'running',
    });
    const result = await invokeAgentRun('tenant-1', 'agent-1');
    expect(result).toEqual({
      kind: 'needs-confirm',
      message: 'A run of this agent is already running.',
    });
  });

  it('leaves every other failure as a plain error', async () => {
    mockFetch(409, { error: 'This agent is turned off.' });
    const result = await invokeAgentRun('tenant-1', 'agent-1');
    expect(result).toEqual({ kind: 'error', message: 'This agent is turned off.' });
  });

  it('sends confirm:true on the retry, so the same in-progress run is not asked about twice', async () => {
    const fetchMock = mockFetch(202, { runId: 'run-2' });
    await invokeAgentRun('tenant-1', 'agent-1', true);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ confirm: true });
  });
});

describe('rerunAgentRun', () => {
  it('hits the rerun route for that run, not the invoke route', async () => {
    const fetchMock = mockFetch(202, { runId: 'run-2' });
    await rerunAgentRun('tenant-1', 'agent-1', 'run-1');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tenant/tenant-1/agents/agent-1/runs/run-1/rerun');
  });

  it('turns an already-in-progress 409 into needs-confirm here too', async () => {
    mockFetch(409, {
      error: 'A run of this agent is already queued.',
      code: 'already-in-progress',
    });
    const result = await rerunAgentRun('tenant-1', 'agent-1', 'run-1');
    expect(result).toEqual({
      kind: 'needs-confirm',
      message: 'A run of this agent is already queued.',
    });
  });
});

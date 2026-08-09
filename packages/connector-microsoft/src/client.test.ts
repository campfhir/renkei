/**
 * graphRequest's contract: relative paths resolve against v1.0, absolute
 * https URLs (delta/paging continuations) pass through verbatim, 204 is a
 * bodiless success, and non-2xx carries the status on the error's cause.
 */

import { graphRequest, GRAPH_BASE_URL } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('graphRequest', () => {
  it('resolves relative paths against the v1.0 base and sends the bearer token', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { id: 'x' }));

    const result = await graphRequest('token-1', '/me/messages');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toEqual({ id: 'x' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${GRAPH_BASE_URL}/me/messages`);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('passes absolute https URLs through untouched', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}));

    const nextLink = 'https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=abc';
    await graphRequest('token-1', nextLink);

    expect(String(fetchMock.mock.calls[0]![0])).toBe(nextLink);
  });

  it('answers ok(null) for a 204', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    const result = await graphRequest('token-1', '/subscriptions/sub-1', { method: 'DELETE' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toBeNull();
  });

  it('fails on non-2xx with the status on cause', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(403, { error: {} }));

    const result = await graphRequest('token-1', '/me/messages');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.type).toBe('GRAPH_API_ERROR');
      expect(result.err.cause).toBe(403);
    }
  });

  it('fails when the network is unreachable', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

    const result = await graphRequest('token-1', '/me/messages');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('GRAPH_API_ERROR');
  });
});

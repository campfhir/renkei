/**
 * graphRequest's contract: relative paths resolve against v1.0, absolute
 * https URLs (delta/paging continuations) pass through verbatim, every
 * request leaves through the grant's fetcher with no Authorization of ours,
 * 204 is a bodiless success, and non-2xx carries the status on the error's
 * cause.
 */

import { graphRequest, GRAPH_BASE_URL } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeAuth() {
  const send = jest.fn<Promise<Response>, [string, RequestInit?]>();
  return Object.assign(send, { grantKey: 'grant-1' });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('graphRequest', () => {
  it('resolves relative paths against the v1.0 base and sends through the grant fetcher', async () => {
    const auth = fakeAuth().mockResolvedValue(jsonResponse(200, { id: 'x' }));
    const globalFetch = jest.spyOn(globalThis, 'fetch');

    const result = await graphRequest(auth, '/me/messages');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toEqual({ id: 'x' });

    expect(globalFetch).not.toHaveBeenCalled();
    const [url, init] = auth.mock.calls[0]!;
    expect(url).toBe(`${GRAPH_BASE_URL}/me/messages`);
    const headers = new Headers(init?.headers);
    // The delegate attaches the credential; nothing here may.
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Accept')).toBe('application/json');
  });

  it('passes absolute https URLs through untouched', async () => {
    const auth = fakeAuth().mockResolvedValue(jsonResponse(200, {}));

    const nextLink = 'https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=abc';
    await graphRequest(auth, nextLink);

    expect(auth.mock.calls[0]![0]).toBe(nextLink);
  });

  it('answers ok(null) for a 204', async () => {
    const auth = fakeAuth().mockResolvedValue(new Response(null, { status: 204 }));

    const result = await graphRequest(auth, '/subscriptions/sub-1', { method: 'DELETE' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toBeNull();
  });

  it('fails on non-2xx with the status on cause', async () => {
    const auth = fakeAuth().mockResolvedValue(jsonResponse(403, { error: {} }));

    const result = await graphRequest(auth, '/me/messages');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.type).toBe('GRAPH_API_ERROR');
      expect(result.err.cause).toBe(403);
    }
  });

  it('fails when the network is unreachable', async () => {
    const auth = fakeAuth().mockRejectedValue(new Error('ECONNRESET'));

    const result = await graphRequest(auth, '/me/messages');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('GRAPH_API_ERROR');
  });
});

/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Regression tests for jiraFetch token handling.
 *
 * The MCP handler cache captures context.accessToken by value when a handler
 * is created, and that closure outlives the token. jiraFetch must therefore
 * resolve the freshest known token for the capture's owner, or every call
 * after the first expiry pays a 401 + refresh + retry round trip forever.
 */

const refreshMock = jest.fn();
jest.mock('@/lib/tenant-operations', () => ({
  refreshAtlassianTokenDirect: (...args: unknown[]) => refreshMock(...args),
}));
jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  secure: (value: unknown) => value,
  redact: (value: unknown) => value,
}));

import { jiraFetch, cacheTokenMetadata } from './common';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function headersOf(call: unknown[]): Record<string, string> {
  const init = call[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  jest.restoreAllMocks();
  refreshMock.mockReset();
});

describe('jiraFetch token refresh', () => {
  it('uses the refreshed token on later calls made with a stale capture', async () => {
    cacheTokenMetadata('stale-token', 'tenant-refresh', 'account-refresh');
    refreshMock.mockResolvedValue({
      ok: true,
      val: { accessToken: 'fresh-token', refreshToken: 'r', expiresAt: new Date() },
    });

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) =>
        ((init?.headers ?? {}) as Record<string, string>).Authorization === 'Bearer fresh-token'
          ? jsonResponse(200)
          : jsonResponse(401)
      );

    // First call: the stale token 401s, gets refreshed, and the retry succeeds.
    await jiraFetch('https://example.test/rest/api/3/myself', 'stale-token');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second call still passes the stale capture — it must go straight through
    // with the refreshed token: no second 401, no second refresh.
    await jiraFetch('https://example.test/rest/api/3/myself', 'stale-token');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(headersOf(fetchMock.mock.calls[2]).Authorization).toBe('Bearer fresh-token');
  });

  it('prefers a token recorded per request over the captured one before any 401', async () => {
    // Simulates the transport route calling cacheTokenMetadata on every
    // request: a token rotated elsewhere is used immediately.
    cacheTokenMetadata('captured-token', 'tenant-rotate', 'account-rotate');
    cacheTokenMetadata('rotated-token', 'tenant-rotate', 'account-rotate');

    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200));

    await jiraFetch('https://example.test/rest/api/3/myself', 'captured-token');
    expect(headersOf(fetchMock.mock.calls[0]).Authorization).toBe('Bearer rotated-token');
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('jiraFetch FormData bodies', () => {
  it('presets no Content-Type, so fetch can write the multipart boundary', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200));

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('hello')]), 'hello.txt');
    await jiraFetch('https://example.test/attachments', 'token-formdata', {
      method: 'POST',
      body: form,
      headers: { 'X-Atlassian-Token': 'no-check' },
    });

    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['X-Atlassian-Token']).toBe('no-check');
    expect(headers.Authorization).toBe('Bearer token-formdata');
  });

  it('keeps the JSON Content-Type for non-FormData bodies', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200));

    await jiraFetch('https://example.test/rest/api/3/issue', 'token-json', {
      method: 'POST',
      body: JSON.stringify({ fields: {} }),
    });

    expect(headersOf(fetchMock.mock.calls[0])['Content-Type']).toBe('application/json');
  });
});

describe('jiraFetch timeouts', () => {
  it('turns a stalled request into a JiraApiError 504 instead of hanging', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

    await expect(jiraFetch('https://example.test/rest/api/3/myself', 'token-t')).rejects.toThrow(
      /timed out after \d+ms/
    );
  });

  it('reports an unreachable API as a JiraApiError instead of a raw TypeError', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    await expect(jiraFetch('https://example.test/rest/api/3/myself', 'token-u')).rejects.toThrow(
      'Could not reach the Jira API'
    );
  });
});

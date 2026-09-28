/**
 * graphFetch's contract: throttled answers are re-sent after Retry-After
 * (idempotent methods only, unless the caller opts in), mailbox URLs share
 * a per-token concurrency gate while other Graph resources do not, and the
 * header helpers read what Graph sends.
 */

import {
  graphFetch,
  headersForLog,
  isMailboxUrl,
  retryAfterMs,
  retryAfterSeconds,
  MAILBOX_CONCURRENCY,
  retryClock,
} from './fetch';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const sleeps: number[] = [];

beforeEach(() => {
  sleeps.length = 0;
  jest.spyOn(retryClock, 'sleep').mockImplementation(async (ms: number) => {
    // Collapse the retry backoff so a throttling test does not sleep for
    // real; every other timer keeps its delay.
    sleeps.push(ms);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isMailboxUrl', () => {
  it.each([
    ['https://graph.microsoft.com/v1.0/me/messages?$top=5', true],
    ["https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta", true],
    ['https://graph.microsoft.com/v1.0/me/events/abc', true],
    ['https://graph.microsoft.com/v1.0/me/calendarView?start=1', true],
    ['https://graph.microsoft.com/v1.0/me/todo/lists', true],
    ['https://graph.microsoft.com/v1.0/me/sendMail', true],
    ['https://graph.microsoft.com/v1.0/users/abc/messages/1', true],
    ['https://graph.microsoft.com/v1.0/$batch', true],
    ['https://graph.microsoft.com/v1.0/me/drive/root/delta', false],
    ['https://graph.microsoft.com/v1.0/drives/d1/items/i1/content', false],
    ['https://graph.microsoft.com/v1.0/users?$search="x"', false],
    ['https://graph.microsoft.com/v1.0/sites/s1/lists', false],
    ['https://graph.microsoft.com/v1.0/subscriptions', false],
  ])('%s → %s', (url, expected) => {
    expect(isMailboxUrl(url)).toBe(expected);
  });
});

describe('Retry-After helpers', () => {
  it('reads delay-seconds', () => {
    const headers = new Headers({ 'Retry-After': '7' });
    expect(retryAfterMs(headers)).toBe(7000);
    expect(retryAfterSeconds(headers)).toBe(7);
  });

  it('reads an HTTP-date', () => {
    const headers = new Headers({ 'Retry-After': new Date(Date.now() + 30_000).toUTCString() });
    const ms = retryAfterMs(headers);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(25_000);
    expect(ms!).toBeLessThanOrEqual(30_000);
  });

  it('is null when absent or unreadable', () => {
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterMs(new Headers({ 'Retry-After': 'soon' }))).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });

  it('headersForLog keeps the diagnostics and drops the body framing', () => {
    const headers = new Headers({
      'request-id': 'r-1',
      'Retry-After': '3',
      'Content-Type': 'application/json',
      'Content-Length': '12',
    });
    expect(headersForLog(headers)).toEqual({ 'request-id': 'r-1', 'retry-after': '3' });
    expect(headersForLog(undefined)).toEqual({});
  });
});

describe('graphFetch retry', () => {
  it('re-sends a throttled GET after Retry-After and returns the eventual answer', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: 'CommandConcurrencyLimitReached' } }, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'x' }));

    const response = await graphFetch('token-1', '/me/messages', { lane: 'interactive' });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });

  it('backs off exponentially when Graph sends no Retry-After, then gives up with the last answer', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(429, { error: { code: 'TooManyRequests' } }));

    const response = await graphFetch('token-1', '/me/messages', { lane: 'interactive' });

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('caps a hostile Retry-After per lane', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(503, {}, { 'Retry-After': '600' }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await graphFetch('token-1', '/me/messages', { lane: 'interactive' });

    expect(sleeps).toEqual([10_000]);
  });

  it('never re-sends a POST on its own — Microsoft may have acted despite the 503', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503, {}));

    const response = await graphFetch('token-1', '/me/sendMail', {
      method: 'POST',
      body: '{}',
      lane: 'interactive',
    });

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('re-sends a POST the caller vouched for', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const response = await graphFetch('token-1', '/$batch', {
      method: 'POST',
      body: '{}',
      retry: true,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends the bearer token and resolves relative paths', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}));

    await graphFetch('token-9', '/me/messages');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://graph.microsoft.com/v1.0/me/messages');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-9');
  });
});

describe('graphFetch mailbox gate', () => {
  it('holds mailbox requests for one token to MAILBOX_CONCURRENCY in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const settle: Array<() => void> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          settle.push(() => {
            inFlight -= 1;
            resolve(jsonResponse(200, {}));
          });
        })
    );

    const calls = Array.from({ length: 5 }, () =>
      graphFetch('same-token', '/me/messages', { lane: 'interactive' })
    );
    // Let every call reach the gate.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(inFlight).toBe(MAILBOX_CONCURRENCY);

    while (settle.length > 0 || inFlight > 0) {
      const next = settle.shift();
      if (next) next();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    await Promise.all(calls);
    expect(peak).toBe(MAILBOX_CONCURRENCY);
  });

  it('does not gate drive or directory requests', async () => {
    let inFlight = 0;
    let peak = 0;
    const settle: Array<() => void> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          settle.push(() => {
            inFlight -= 1;
            resolve(jsonResponse(200, {}));
          });
        })
    );

    const calls = Array.from({ length: 5 }, () =>
      graphFetch('same-token', '/me/drive/root/children', { lane: 'interactive' })
    );
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(inFlight).toBe(5);
    for (const next of settle) next();
    await Promise.all(calls);
    expect(peak).toBe(5);
  });
});

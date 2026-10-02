/**
 * graphFetch's contract: throttled answers are re-sent after Retry-After
 * (idempotent methods only, unless the caller opts in), mailbox URLs share
 * a per-grant concurrency gate while other Graph resources do not, every
 * request goes out through the grant's own fetcher with no Authorization
 * of ours, and the header helpers read what Graph sends.
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

/** A grant's fetcher as a test double: the mock IS the delegate. */
function fakeAuth(grantKey = 'grant-1') {
  const send = jest.fn<Promise<Response>, [string, RequestInit?]>();
  return Object.assign(send, { grantKey });
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
    const auth = fakeAuth()
      .mockResolvedValueOnce(
        jsonResponse(
          503,
          { error: { code: 'CommandConcurrencyLimitReached' } },
          { 'Retry-After': '2' }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { id: 'x' }));

    const response = await graphFetch(auth, '/me/messages', { lane: 'interactive' });

    expect(response.status).toBe(200);
    expect(auth).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });

  it('backs off exponentially when Graph sends no Retry-After, then gives up with the last answer', async () => {
    const auth = fakeAuth().mockResolvedValue(
      jsonResponse(429, { error: { code: 'TooManyRequests' } })
    );

    const response = await graphFetch(auth, '/me/messages', { lane: 'interactive' });

    expect(response.status).toBe(429);
    expect(auth).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('caps a hostile Retry-After per lane', async () => {
    const auth = fakeAuth()
      .mockResolvedValueOnce(jsonResponse(503, {}, { 'Retry-After': '600' }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await graphFetch(auth, '/me/messages', { lane: 'interactive' });

    expect(sleeps).toEqual([10_000]);
  });

  it('never re-sends a POST on its own — Microsoft may have acted despite the 503', async () => {
    const auth = fakeAuth().mockResolvedValue(jsonResponse(503, {}));

    const response = await graphFetch(auth, '/me/sendMail', {
      method: 'POST',
      body: '{}',
      lane: 'interactive',
    });

    expect(response.status).toBe(503);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('re-sends a POST the caller vouched for', async () => {
    const auth = fakeAuth()
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const response = await graphFetch(auth, '/$batch', {
      method: 'POST',
      body: '{}',
      retry: true,
    });

    expect(response.status).toBe(200);
    expect(auth).toHaveBeenCalledTimes(2);
  });

  it('sends through the grant fetcher, resolves relative paths, and sets no Authorization', async () => {
    const auth = fakeAuth().mockResolvedValue(jsonResponse(200, {}));
    const globalFetch = jest.spyOn(globalThis, 'fetch');

    await graphFetch(auth, '/me/messages', { headers: { Accept: 'application/json' } });

    expect(globalFetch).not.toHaveBeenCalled();
    const [url, init] = auth.mock.calls[0]!;
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Accept')).toBe('application/json');
    // A per-attempt deadline still rides on every request.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('graphFetch mailbox gate', () => {
  function slowAuth(grantKey: string, onCall: (settle: () => void) => void) {
    return fakeAuth(grantKey).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          onCall(() => resolve(jsonResponse(200, {})));
        })
    );
  }

  it('holds mailbox requests for one grant to MAILBOX_CONCURRENCY in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const settle: Array<() => void> = [];
    const auth = slowAuth('same-grant', (done) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      settle.push(() => {
        inFlight -= 1;
        done();
      });
    });

    const calls = Array.from({ length: 5 }, () =>
      graphFetch(auth, '/me/messages', { lane: 'interactive' })
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
    const auth = slowAuth('same-grant', (done) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      settle.push(() => {
        inFlight -= 1;
        done();
      });
    });

    const calls = Array.from({ length: 5 }, () =>
      graphFetch(auth, '/me/drive/root/children', { lane: 'interactive' })
    );
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(inFlight).toBe(5);
    for (const next of settle) next();
    await Promise.all(calls);
    expect(peak).toBe(5);
  });

  it('keys the gate by grantKey, so two grants do not share a mailbox slot', async () => {
    let inFlight = 0;
    const settle: Array<() => void> = [];
    const onCall = (done: () => void) => {
      inFlight += 1;
      settle.push(() => {
        inFlight -= 1;
        done();
      });
    };
    const alice = slowAuth('grant-alice', onCall);
    const bob = slowAuth('grant-bob', onCall);

    const calls = [
      graphFetch(alice, '/me/messages', { lane: 'interactive' }),
      graphFetch(alice, '/me/messages', { lane: 'interactive' }),
      graphFetch(bob, '/me/messages', { lane: 'interactive' }),
      graphFetch(bob, '/me/messages', { lane: 'interactive' }),
    ];
    // Polled rather than counted in microtasks: the process-wide limiter
    // may owe this test a refill after the suite above. One shared gate
    // would hold the count at MAILBOX_CONCURRENCY until something settles.
    const deadline = Date.now() + 2_000;
    while (inFlight < 2 * MAILBOX_CONCURRENCY && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(inFlight).toBe(2 * MAILBOX_CONCURRENCY);

    for (const next of settle) next();
    await Promise.all(calls);
  });
});

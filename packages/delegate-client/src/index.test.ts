/**
 * The client against a scripted fetch: the wire it speaks (one POST per
 * op under /v1, bearer key, JSON body), how a status answer is read into
 * dates and lists, and how a failure comes back as the delegate's own
 * error tag — or a transport verdict when the delegate is not configured
 * or not reachable.
 */

import { DelegateClient, DelegateTransport, type FetchLike } from './index';

interface Call {
  url: string;
  init: RequestInit;
}

function scripted(answer: (call: Call) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: (url, init) => {
      const call = { url, init };
      calls.push(call);
      return Promise.resolve(answer(call));
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const config = { url: 'http://delegate.test:8096', apiKey: 'k-1' };

describe('DelegateClient', () => {
  it('posts one op under /v1 with the bearer key and a JSON body', async () => {
    const { fetchImpl, calls } = scripted(() => json(200, { held: 2, managed: 1, own: 0 }));
    const client = new DelegateClient(new DelegateTransport(config, fetchImpl));
    const census = await client.enrollmentCensus('tenant-1');
    expect(census).toEqual({ ok: true, val: { held: 2, managed: 1, own: 0 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://delegate.test:8096/v1/keys/census');
    expect(calls[0]!.init.method).toBe('POST');
    const headers: Record<string, string> =
      calls[0]!.init.headers && !Array.isArray(calls[0]!.init.headers)
        ? Object.fromEntries(Object.entries(calls[0]!.init.headers))
        : {};
    expect(headers.authorization).toBe('Bearer k-1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ tenantId: 'tenant-1' });
  });

  it('reads a key status into dates and string lists, defaulting what is missing', async () => {
    const enrolledAt = '2026-10-01T12:00:00.000Z';
    const { fetchImpl } = scripted(() =>
      json(200, {
        enrolled: true,
        publicKey: 'pk',
        version: 3,
        enrolledAt,
        sessionInstances: ['i-1', 7, null],
        automationInstances: [],
        automationUntil: 'not a date',
      })
    );
    const client = new DelegateClient(new DelegateTransport(config, fetchImpl));
    const status = await client.keyStatus('tenant-1', 'alice', 'session-1');
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.val).toEqual({
      enrolled: true,
      legacy: false,
      legacyNeedsPassphrase: false,
      publicKey: 'pk',
      wrappedPrivateKey: null,
      wrappedAutomationKey: null,
      version: 3,
      enrolledAt: new Date(enrolledAt),
      sessionInstances: ['i-1'],
      thisSessionInstances: [],
      automationInstances: [],
      automationUntil: null,
    });
  });

  it("hands back the delegate's own error tag, and DELEGATE_ERROR for one it does not know", async () => {
    const locked = scripted(() =>
      json(423, { error: { type: 'NEEDS_DELEGATION', message: 'seal again' } })
    );
    const client = new DelegateClient(new DelegateTransport(config, locked.fetchImpl));
    const status = await client.keyStatus('tenant-1', 'alice');
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.err.type).toBe('NEEDS_DELEGATION');

    const odd = scripted(() => json(500, { error: { type: 'something_new' } }));
    const other = new DelegateClient(new DelegateTransport(config, odd.fetchImpl));
    const census = await other.enrollmentCensus();
    expect(census.ok).toBe(false);
    if (census.ok) return;
    expect(census.err.type).toBe('DELEGATE_ERROR');
  });

  it('says so when the delegate is not configured or cannot be reached', async () => {
    const unconfigured = new DelegateClient(
      new DelegateTransport(null, scripted(() => json(200, {})).fetchImpl)
    );
    const missing = await unconfigured.keyStatus('tenant-1', 'alice');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.err.type).toBe('DELEGATE_UNCONFIGURED');

    const down = scripted(() => {
      throw new TypeError('fetch failed');
    });
    const client = new DelegateClient(new DelegateTransport(config, down.fetchImpl));
    const status = await client.keyStatus('tenant-1', 'alice');
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.err.type).toBe('DELEGATE_UNREACHABLE');
  });
});

/**
 * The client against a scripted fetch: the wire it speaks (one POST per
 * op under /v1, bearer key, JSON body), how a status answer is read into
 * dates and lists, and how a failure comes back as the delegate's own
 * error tag — or a transport verdict when the delegate is not configured
 * or not reachable.
 */

import {
  DelegateClient,
  DelegateTransport,
  DEVELOPMENT_DELEGATE_KEY,
  delegateApiKeyFromEnv,
  delegateConfigFromEnv,
  developmentDelegateKeyRefusal,
  type FetchLike,
} from './index';

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

describe('delegateConfigFromEnv', () => {
  it("takes this process's own key first, else its named entry in the shared map", () => {
    expect(
      delegateApiKeyFromEnv({ DELEGATE_WORKER_API_KEY: 'own', DELEGATE_WORKER_API_KEYS: 'web=w' })
    ).toBe('own');
    expect(
      delegateApiKeyFromEnv({
        DELEGATE_WORKER_CALLER: 'agents',
        DELEGATE_WORKER_API_KEYS: 'web=w, agents=a ,worker=k',
      })
    ).toBe('a');
    expect(
      delegateApiKeyFromEnv({
        DELEGATE_WORKER_CALLER: 'sandbox',
        DELEGATE_WORKER_API_KEYS: 'web=w',
      })
    ).toBeNull();
    expect(delegateApiKeyFromEnv({ DELEGATE_WORKER_API_KEYS: 'web=w' })).toBeNull();
    expect(
      delegateConfigFromEnv({
        DELEGATE_WORKER_URL: 'http://delegate:8096/',
        DELEGATE_WORKER_CALLER: 'worker',
        DELEGATE_WORKER_API_KEYS: 'worker=k',
      })
    ).toEqual({ url: 'http://delegate:8096', apiKey: 'k' });
  });

  it('refuses the development default key in production, at boot and at first use', () => {
    const production = {
      NODE_ENV: 'production',
      DELEGATE_WORKER_URL: 'http://delegate:8096',
      DELEGATE_WORKER_API_KEY: DEVELOPMENT_DELEGATE_KEY,
    };
    expect(developmentDelegateKeyRefusal(production)).toMatch(/development default/);
    expect(() => delegateConfigFromEnv(production)).toThrow(/development default/);
    expect(developmentDelegateKeyRefusal({ ...production, NODE_ENV: 'development' })).toBeNull();
    expect(
      developmentDelegateKeyRefusal({ ...production, DELEGATE_WORKER_API_KEY: 'real' })
    ).toBeNull();
    expect(delegateConfigFromEnv({ ...production, DELEGATE_WORKER_API_KEY: 'real' })).toEqual({
      url: 'http://delegate:8096',
      apiKey: 'real',
    });
  });
});

describe('DelegateClient', () => {
  it('binds a session or a run to every body of a derived client', async () => {
    const { fetchImpl, calls } = scripted(() => json(200, { enrolled: true }));
    const client = new DelegateClient(new DelegateTransport(config, fetchImpl));
    await client.forSession('session-1').keyStatus('tenant-1', 'alice');
    await client.forRun('run-1').keyStatus('tenant-1', 'alice');
    await client.keyStatus('tenant-1', 'alice');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      subject: 'alice',
      sessionId: 'session-1',
    });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      subject: 'alice',
      runId: 'run-1',
    });
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({
      subject: 'alice',
    });
  });

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
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ });
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

/**
 * Where a call goes when sandboxes are orchestrated: to the scope's own
 * sandbox, at the address and with the key the orchestrator answers.
 */

import { isRecord } from '@renkei/guards';
import {
  forgetSandboxEndpoint,
  resetSandboxRoutingForTests,
  sandboxConfig,
  sandboxAuthHeaders,
  sandboxEndpointFor,
  sandboxEndpoints,
  sandboxRouteKey,
} from './routing';

const ORCHESTRATOR = 'http://orchestrator.internal:8097';
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

interface Asked {
  url: string;
  authorization: string | null;
  body: unknown;
}

let asked: Asked[] = [];
let answer: (asked: Asked) => Response | Promise<Response>;

/** The scope an ask names. */
function keyOf(request: Asked): string {
  return isRecord(request.body) && typeof request.body.key === 'string' ? request.body.key : '';
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  asked = [];
  answer = (request) => {
    const key = keyOf(request);
    return json({ sandboxId: `id-${key}`, url: `http://${key}.sandbox:8092/`, key: `key-${key}` });
  };
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const request: Asked = {
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    asked.push(request);
    return answer(request);
  });
  process.env.SANDBOX_ORCHESTRATOR_URL = `${ORCHESTRATOR}/`;
  process.env.SANDBOX_ORCHESTRATOR_API_KEY = 'orchestrator-key';
  resetSandboxRoutingForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.SANDBOX_ORCHESTRATOR_URL;
  delete process.env.SANDBOX_ORCHESTRATOR_API_KEY;
});

describe('with an orchestrator', () => {
  it('a call goes to the scope’s own sandbox, with that sandbox’s own key', async () => {
    expect(await sandboxEndpointFor('ann', T0)).toEqual({
      url: 'http://ann.sandbox:8092',
      key: 'key-ann',
    });
    expect(asked).toEqual([
      {
        url: `${ORCHESTRATOR}/v1/ensure`,
        authorization: 'Bearer orchestrator-key',
        body: { key: 'ann' },
      },
    ]);
  });

  it('a call carries the key as its bearer, unless the orchestrator says what the sandbox’s door wants instead', async () => {
    const plain = await sandboxEndpointFor('ann', T0);
    expect(plain && sandboxAuthHeaders(plain)).toEqual({ authorization: 'Bearer key-ann' });

    answer = () =>
      json({
        url: 'http://bob.sandbox:8092',
        key: 'key-bob',
        headers: { Authorization: 'Bearer entra-token', 'x-sandbox-key': 'key-bob', odd: 7 },
      });
    const guarded = await sandboxEndpointFor('bob', T0);
    expect(guarded && sandboxAuthHeaders(guarded)).toEqual({
      authorization: 'Bearer entra-token',
      'x-sandbox-key': 'key-bob',
    });
    // Remembered with the address.
    const again = await sandboxEndpointFor('bob', T0 + 1_000);
    expect(again && sandboxAuthHeaders(again)).toEqual(guarded && sandboxAuthHeaders(guarded));
  });

  it('a person, an agent and a code project are each asked for by their own scope', async () => {
    await sandboxEndpointFor('ann', T0);
    await sandboxEndpointFor('agent:a1', T0);
    await sandboxEndpointFor('code-project:p1', T0);
    expect(asked.map(keyOf)).toEqual(['ann', 'agent:a1', 'code-project:p1']);
  });

  it('a call made for no caller goes to the system sandbox', async () => {
    expect((await sandboxEndpointFor(null, T0))?.url).toBe('http://system.sandbox:8092');
  });

  it('the answer is remembered for ten seconds, then asked again — which is what keeps the scope marked in use', async () => {
    await sandboxEndpointFor('ann', T0);
    await sandboxEndpointFor('ann', T0 + 9_000);
    expect(asked).toHaveLength(1);
    await sandboxEndpointFor('ann', T0 + 11_000);
    expect(asked).toHaveLength(2);
  });

  it('a call that did not connect makes the next ask tell the orchestrator to check the sandbox first', async () => {
    await sandboxEndpointFor('ann', T0);
    forgetSandboxEndpoint('ann');
    await sandboxEndpointFor('ann', T0 + 1_000);
    expect(asked[1]?.body).toEqual({ key: 'ann', verify: true });
    // Once it has answered, the next ask is an ordinary one.
    await sandboxEndpointFor('ann', T0 + 20_000);
    expect(asked[2]?.body).toEqual({ key: 'ann' });
  });

  it('a sandbox still starting sends the call to the orchestrator’s refusal, and is not remembered', async () => {
    answer = () => json({ error: { type: 'starting' } }, 503);
    expect(await sandboxEndpointFor('ann', T0)).toEqual({
      url: `${ORCHESTRATOR}/unavailable/starting`,
      key: 'orchestrator-key',
    });
    answer = (request) => json({ url: 'http://ann.sandbox:8092', key: 'key-ann', body: request });
    expect((await sandboxEndpointFor('ann', T0 + 1))?.url).toBe('http://ann.sandbox:8092');
  });

  it('a sandbox that could not be made, or an orchestrator that is down, sends the call to the refusal too', async () => {
    answer = () => json({ error: { type: 'provider' } }, 502);
    expect((await sandboxEndpointFor('ann', T0))?.url).toBe(`${ORCHESTRATOR}/unavailable/provider`);
    answer = () => {
      throw new Error('ECONNREFUSED');
    };
    expect((await sandboxEndpointFor('bob', T0))?.url).toBe(`${ORCHESTRATOR}/unavailable/provider`);
  });

  it('the sandbox is configured, and its capabilities are asked of the orchestrator', () => {
    expect(sandboxConfig()).toEqual({ url: ORCHESTRATOR, key: 'orchestrator-key' });
  });

  it('every running sandbox is what the orchestrator lists as running', async () => {
    answer = () =>
      json({
        sandboxes: [
          { id: '1', state: 'running', url: 'http://a:8092/', key: 'ka' },
          { id: '2', state: 'suspended' },
          { id: '3', state: 'running', url: 'http://c:8092', key: 'kc' },
        ],
      });
    expect(await sandboxEndpoints(T0)).toEqual([
      { url: 'http://a:8092', key: 'ka' },
      { url: 'http://c:8092', key: 'kc' },
    ]);
    expect(asked[0]?.url).toBe(`${ORCHESTRATOR}/v1/list`);
  });

  it('a call in a code project’s scratch space is served by the project’s sandbox; an agent’s by the agent’s', () => {
    expect(sandboxRouteKey({ subject: 'ann' })).toBe('ann');
    expect(sandboxRouteKey({ subject: 'ann', scope: 'chat:c1' })).toBe('ann');
    expect(sandboxRouteKey({ subject: 'ann', scope: 'project:p1' })).toBe('code-project:p1');
    expect(sandboxRouteKey({ subject: 'code-project:p1', scope: 'project:p1' })).toBe(
      'code-project:p1'
    );
    expect(sandboxRouteKey({ subject: 'ann', scope: 'project:p1', route: 'agent:a1' })).toBe(
      'agent:a1'
    );
  });
});

describe('without an orchestrator', () => {
  it('a code project’s scratch space stays with the caller, as it always was', () => {
    delete process.env.SANDBOX_ORCHESTRATOR_URL;
    expect(sandboxRouteKey({ subject: 'ann', scope: 'project:p1' })).toBe('ann');
  });
});

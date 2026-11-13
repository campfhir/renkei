/**
 * Where a call goes when sandboxes are orchestrated: to the scope's own
 * sandbox, at the address and with the key the orchestrator answers.
 */

import { isRecord } from '@renkei/guards';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import {
  exposeSandboxPort,
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

  it('the orchestrator is told whom the call is for, so the sandbox’s own data calls can be held to them', async () => {
    await sandboxEndpointFor('code-project:p1', T0, 'ann');
    expect(asked[0]?.body).toEqual({ key: 'code-project:p1', subject: 'ann' });
    // Another member in the same project is asked for separately: each is named once.
    await sandboxEndpointFor('code-project:p1', T0, 'bob');
    await sandboxEndpointFor('code-project:p1', T0 + 1_000, 'ann');
    expect(asked.map((request) => request.body)).toEqual([
      { key: 'code-project:p1', subject: 'ann' },
      { key: 'code-project:p1', subject: 'bob' },
    ]);
  });

  it('a call that did not connect forgets the scope’s sandbox whoever it was asked for', async () => {
    await sandboxEndpointFor('code-project:p1', T0, 'ann');
    await sandboxEndpointFor('code-project:p1', T0, 'bob');
    forgetSandboxEndpoint('code-project:p1');
    await sandboxEndpointFor('code-project:p1', T0 + 1_000, 'ann');
    await sandboxEndpointFor('code-project:p1', T0 + 1_000, 'bob');
    expect(asked).toHaveLength(4);
    expect(asked[2]?.body).toEqual({ key: 'code-project:p1', subject: 'ann', verify: true });
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

  it('a call in a code project’s scratch space is served by the project’s sandbox; an agent’s by the agent’s', async () => {
    expect(await sandboxRouteKey({ subject: 'ann' })).toBe('ann');
    expect(await sandboxRouteKey({ subject: 'ann', scope: 'project:p1' })).toBe('code-project:p1');
    expect(await sandboxRouteKey({ subject: 'code-project:p1', scope: 'project:p1' })).toBe(
      'code-project:p1'
    );
    expect(await sandboxRouteKey({ subject: 'ann', scope: 'project:p1', route: 'agent:a1' })).toBe(
      'agent:a1'
    );
  });
});

describe('a chat, with an orchestrator', () => {
  let store: MemoryDataStore;
  let chatProject: string;
  let codeProject: string;
  const chatIn = async (owner: string, projectId: string | null) => {
    return store.chats.create({
      ownerSubject: owner,
      projectId,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });
  };

  beforeEach(async () => {
    store = createMemoryDataStore();
    registerDataStore(store);
    chatProject = await store.chatProjects.create({
      ownerSubject: 'ann',
      name: 'Shared research',
      description: null,
      toolConfig: {},
    });
    codeProject = await store.chatProjects.create({
      ownerSubject: 'ann',
      name: 'The app',
      description: null,
      toolConfig: {},
      repo: { provider: 'github', fullName: 'acme/app', branch: null },
    });
  });
  afterEach(() => resetDataStore());

  it('of nobody’s project is served by its person’s own sandbox', async () => {
    const chat = await chatIn('ann', null);
    expect(await sandboxRouteKey({ subject: 'ann', scope: `chat:${chat}` })).toBe('ann');
  });

  it('in a chat project is served by the project’s sandbox, whoever in the project is chatting', async () => {
    const hers = await chatIn('ann', chatProject);
    const his = await chatIn('bob', chatProject);
    expect(await sandboxRouteKey({ subject: 'ann', scope: `chat:${hers}` })).toBe(
      `chat-project:${chatProject}`
    );
    expect(await sandboxRouteKey({ subject: 'bob', scope: `chat:${his}` })).toBe(
      `chat-project:${chatProject}`
    );
  });

  it('in a code project is served by that project’s sandbox, beside its checkout', async () => {
    const chat = await chatIn('ann', codeProject);
    expect(await sandboxRouteKey({ subject: 'ann', scope: `chat:${chat}` })).toBe(
      `code-project:${codeProject}`
    );
  });

  it('run by an agent is still served by the agent’s', async () => {
    const chat = await chatIn('ann', chatProject);
    expect(
      await sandboxRouteKey({ subject: 'ann', scope: `chat:${chat}`, route: 'agent:a1' })
    ).toBe('agent:a1');
  });

  it('moved into a project is served there within a minute', async () => {
    const chat = await chatIn('ann', null);
    const target = { subject: 'ann', scope: `chat:${chat}` };
    expect(await sandboxRouteKey(target, T0)).toBe('ann');
    await store.chats.move('ann', chat, chatProject);
    expect(await sandboxRouteKey(target, T0 + 30_000)).toBe('ann');
    expect(await sandboxRouteKey(target, T0 + 61_000)).toBe(`chat-project:${chatProject}`);
  });

  it('that cannot be found is served as its person’s own', async () => {
    expect(
      await sandboxRouteKey({
        subject: 'ann',
        scope: 'chat:00000000-0000-4000-8000-000000000000',
      })
    ).toBe('ann');
  });
});

describe('a port opened to people’s own browsers', () => {
  it('is asked of the orchestrator with the people the server names, and answers its address', async () => {
    answer = () => json({ url: 'https://az-1-5173.example' });
    expect(await exposeSandboxPort('code-project:p1', 5173, ['ada@contoso.com'])).toEqual({
      ok: true,
      url: 'https://az-1-5173.example',
    });
    expect(asked[0]).toEqual({
      url: `${ORCHESTRATOR}/v1/expose`,
      authorization: 'Bearer orchestrator-key',
      body: { key: 'code-project:p1', port: 5173, emails: ['ada@contoso.com'] },
    });
  });

  it('has no address where the provider has no such door, and says why when it is refused', async () => {
    answer = () => json({ url: null });
    expect(await exposeSandboxPort('code-project:p1', 5173, ['a@b.c'])).toEqual({
      ok: true,
      url: null,
    });
    answer = () => json({ error: { type: 'bad_request', message: 'name the people' } }, 400);
    expect(await exposeSandboxPort('code-project:p1', 5173, [])).toEqual({
      ok: false,
      message: 'name the people',
    });
  });
});

describe('without an orchestrator', () => {
  it('a code project’s scratch space stays with the caller, as it always was, and no port is opened', async () => {
    delete process.env.SANDBOX_ORCHESTRATOR_URL;
    expect(await sandboxRouteKey({ subject: 'ann', scope: 'project:p1' })).toBe('ann');
    expect(await exposeSandboxPort('code-project:p1', 5173, ['a@b.c'])).toEqual({
      ok: true,
      url: null,
    });
    expect(asked).toEqual([]);
  });
});

/**
 * What the builder's Save reaches: POST /api/agents creates, PUT
 * /api/agents/:id updates, on the memory store. A save the shared validator
 * refuses is a 422 carrying the per-field issues the builder draws where
 * its own check would; a malformed body is a 400; what was saved reads
 * back through GET as the builder sent it. (agent-instructions.spec.ts
 * used to check the read-back through a browser.)
 */

jest.mock('next/server', () => ({
  ...jest.requireActual<object>('next/server'),
  // Outside a request scope `after` throws; the deferred work runs inline here.
  after: (task: () => unknown) => void task(),
}));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({
  listAvailableTools: jest.fn(async () => [
    { name: 'agent_list', appOnly: false },
    { name: 'agent_get', appOnly: false },
    { name: 'widget_resolve', appOnly: true },
  ]),
}));
jest.mock('@/lib/agents/describe', () => ({ generateAgentDescription: jest.fn(async () => {}) }));
jest.mock('@/lib/agents/edit-notification', () => ({ notifyAgentEdited: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET as LIST, POST } from './route';
import { GET, PUT } from './[agentId]/route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const INSTRUCTIONS = '## Goal\n\nEach morning, list the agents nobody has run lately.';

function request(method: string, body: unknown): NextRequest {
  return new NextRequest('http://test.local/api/agents', {
    method,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const params = (agentId: string) => ({ params: Promise.resolve({ agentId }) });

/** What the builder's Save sends for a new agent (agent-builder.model.ts saveRequestOf). */
function saveBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `Idle agents digest ${randomUUID().slice(0, 6)}`,
    instructions: INSTRUCTIONS,
    tools: ['agent_list', 'agent_get'],
    triggers: [],
    enabled: false,
    llmModelId: null,
    guardrails: null,
    canAskQuestions: true,
    autoAcceptActions: false,
    refreshDescription: true,
    ...overrides,
  };
}

let subject: string;

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  subject = `auth0|${randomUUID()}`;
  mockGetSession.mockResolvedValue({ subject });
});

afterEach(() => resetDataStore());

async function create(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await POST(request('POST', saveBody(overrides)));
  expect(response.status).toBe(201);
  const body = await response.json();
  return body.agentId;
}

describe('POST /api/agents (Save on a new agent)', () => {
  it('refuses without a session', async () => {
    mockGetSession.mockResolvedValue(null);
    const response = await POST(request('POST', saveBody()));
    expect(response.status).toBe(401);
  });

  it('refuses a body that is not an agent, saying what is missing', async () => {
    const response = await POST(request('POST', { name: 'x', instructions: 'y' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'tools must be a list of tool names' });
    expect((await POST(request('POST', 'not json'))).status).toBe(400);
  });

  it('creates the agent, off, and reads back exactly what was saved', async () => {
    const response = await POST(request('POST', saveBody({ name: 'Idle agents digest' })));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({ apiKeys: [], descriptionPending: true });

    const read = await GET(request('GET', undefined), params(created.agentId));
    const { agent } = await read.json();
    expect(agent).toMatchObject({
      name: 'Idle agents digest',
      instructions: INSTRUCTIONS,
      tools: ['agent_list', 'agent_get'],
      enabled: false,
      canAskQuestions: true,
      autoAcceptActions: false,
    });
  });

  it('mints an API trigger’s key once, on the create', async () => {
    const response = await POST(
      request(
        'POST',
        saveBody({ triggers: [{ draft: { kind: 'api', inputs: [] }, enabled: true }] })
      )
    );
    const created = await response.json();
    expect(created.apiKeys).toEqual([{ triggerId: expect.any(String), key: expect.any(String) }]);
  });

  it('refuses what the validator refuses with per-field issues, and stores nothing', async () => {
    const response = await POST(
      request(
        'POST',
        saveBody({
          name: ' ',
          instructions: '## Goal\n\n## Rules\n',
          tools: ['agent_get', 'gone_tool', 'widget_resolve'],
        })
      )
    );
    expect(response.status).toBe(422);
    const { issues } = await response.json();
    expect(issues.map((issue: { path: string }) => issue.path)).toEqual([
      'name',
      'instructions',
      'tools.1',
      'tools.2',
    ]);
    const list = await LIST(request('GET', undefined));
    expect((await list.json()).agents).toEqual([]);
  });

  it('refuses turning an agent on with no trigger', async () => {
    const response = await POST(request('POST', saveBody({ enabled: true })));
    expect(response.status).toBe(422);
    expect((await response.json()).issues).toEqual([
      { path: 'triggers', message: 'Add at least one trigger before turning the agent on.' },
    ]);
  });
});

describe('PUT /api/agents/:id (Update on an existing agent)', () => {
  it('saves the edit and answers the agent as stored', async () => {
    const agentId = await create();
    const response = await PUT(
      request('PUT', saveBody({ name: 'Renamed', autoAcceptActions: true, tools: ['agent_get'] })),
      params(agentId)
    );
    expect(response.status).toBe(200);
    const { agent } = await response.json();
    expect(agent).toMatchObject({
      id: agentId,
      name: 'Renamed',
      tools: ['agent_get'],
      autoAcceptActions: true,
    });
  });

  it('refuses an invalid edit with its issues and keeps the agent as it was', async () => {
    const agentId = await create({ name: 'Kept' });
    const response = await PUT(
      request('PUT', saveBody({ name: 'Changed', tools: ['gone_tool'] })),
      params(agentId)
    );
    expect(response.status).toBe(422);
    expect((await response.json()).issues).toEqual([expect.objectContaining({ path: 'tools.0' })]);
    const { agent } = await (await GET(request('GET', undefined), params(agentId))).json();
    expect(agent.name).toBe('Kept');
  });

  it('is a 404 for someone else’s agent', async () => {
    const agentId = await create();
    mockGetSession.mockResolvedValue({ subject: `auth0|${randomUUID()}` });
    const response = await PUT(request('PUT', saveBody()), params(agentId));
    expect(response.status).toBe(404);
  });
});

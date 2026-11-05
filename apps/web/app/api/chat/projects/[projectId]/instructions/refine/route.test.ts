/**
 * Asking for refined project instructions, on the memory store: the
 * draft as it stands in the field goes to the model, the proposal comes
 * back, its tokens are recorded, and nothing is saved.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/agent-llm', () => ({
  ...jest.requireActual('@renkei/agent-llm'),
  resolveAgentLlm: jest.fn(),
}));
jest.mock('@renkei/agents/runs', () => ({
  ...jest.requireActual('@renkei/agents/runs'),
  recordLlmCall: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createProject, getProjectRow } from '@/lib/chat/projects';
import { REFINE_TOOL } from '@/lib/chat/refine-instructions';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { resolveAgentLlm: mockResolve } = jest.requireMock<{ resolveAgentLlm: jest.Mock }>(
  '@renkei/agent-llm'
);
const { recordLlmCall: mockRecord } = jest.requireMock<{ recordLlmCall: jest.Mock }>(
  '@renkei/agents/runs'
);

const ME = 'alice';

describe('POST /api/chat/projects/:id/instructions/refine', () => {
  const complete = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    registerDataStore(createMemoryDataStore());
    mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
    complete.mockResolvedValue({
      ok: true,
      val: {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: REFINE_TOOL,
            input: { instructions: 'You help with hiring.' },
          },
        ],
        usage: { inputTokens: 120, outputTokens: 30 },
      },
    });
    mockResolve.mockResolvedValue({
      ok: true,
      val: {
        provider: { complete },
        providerName: 'openai',
        model: 'stub-model',
        modelConfigId: null,
        maxOutputTokens: 4_096,
      },
    });
  });

  afterEach(() => resetDataStore());

  async function newProject(): Promise<string> {
    const id = await createProject({
      ownerSubject: ME,
      name: 'Hiring',
      description: null,
      instructions: null,
      toolConfig: null,
    });
    if (!id) throw new Error('project not created');
    return id;
  }

  const ask = (projectId: string, body: unknown) =>
    POST(
      new NextRequest(`http://test.local/api/chat/projects/${projectId}/instructions/refine`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectId }) }
    );

  it('answers the rewrite of the draft sent, records its tokens and saves nothing', async () => {
    const projectId = await newProject();
    const response = await ask(projectId, { instructions: 'help w/ hiring', guidance: 'shorter' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      instructions: 'You help with hiring.',
    });
    const sent = complete.mock.calls[0][0];
    expect(sent.toolChoice).toEqual({ name: REFINE_TOOL });
    expect(sent.messages[0].content[0].text).toContain('help w/ hiring');
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ subject: ME, purpose: 'instructions_refine', inputTokens: 120 })
    );
    expect(mockResolve).toHaveBeenCalledWith(null);
    expect((await getProjectRow(projectId))?.sealedInstructions).toBeNull();
  });

  it('refuses an empty draft without asking the model', async () => {
    const projectId = await newProject();
    const response = await ask(projectId, { instructions: '   ' });
    expect(response.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses a model that is not on the roster', async () => {
    const projectId = await newProject();
    const response = await ask(projectId, { instructions: 'x', llmModelId: 'nope' });
    expect(response.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it('is not found for someone the project is not shared with', async () => {
    const projectId = await newProject();
    mockGetSession.mockResolvedValue({ subject: 'mallory', roles: ['renkei-user'] });
    const response = await ask(projectId, { instructions: 'x' });
    expect(response.status).toBe(404);
    expect(complete).not.toHaveBeenCalled();
  });

  it('says so when the model fails', async () => {
    const projectId = await newProject();
    complete.mockResolvedValue({ ok: false, err: { type: 'server', message: 'boom' } });
    const response = await ask(projectId, { instructions: 'x' });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/could not refine/);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

/**
 * Asking for a refined or drafted library prompt, on the memory store: the
 * title and draft as they stand in the editor go to the model, the proposal
 * comes back, its tokens are recorded, and nothing is saved.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/token-limits/refusal', () => ({ tokenLimitRefusal: jest.fn(async () => null) }));
jest.mock('@renkei/agent-llm', () => ({
  ...jest.requireActual('@renkei/agent-llm'),
  resolveAgentLlm: jest.fn(),
}));
jest.mock('@renkei/agents/runs', () => ({
  ...jest.requireActual('@renkei/agents/runs'),
  recordLlmCall: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createLibrary, createPrompt, listPrompts } from '@/lib/chat/prompts';
import { REFINE_PROMPT_TOOL } from '@/lib/chat/refine-prompt';
import { POST } from './route';

const { tokenLimitRefusal: mockRefusal } = jest.requireMock<{ tokenLimitRefusal: jest.Mock }>(
  '@/lib/token-limits/refusal'
);

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
const PROPOSED = 'Review {{file}} for bugs.\n\n```variables\nfile:\n  required: true\n```';

describe('POST /api/chat/prompt-libraries/:id/prompts/refine', () => {
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
            name: REFINE_PROMPT_TOOL,
            input: { body: PROPOSED, title: 'Review a file' },
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

  const newLibrary = (scope: 'any' | 'code' = 'code') =>
    createLibrary({ ownerSubject: ME, name: 'Development', description: 'Repo prompts', scope });

  const ask = (libraryId: string, body: unknown) =>
    POST(
      new NextRequest(`http://test.local/api/chat/prompt-libraries/${libraryId}/prompts/refine`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ libraryId }) }
    );

  it('answers the rewrite of the draft sent, records its tokens and saves nothing', async () => {
    const libraryId = await newLibrary();
    const response = await ask(libraryId, {
      title: '',
      body: 'review the file',
      guidance: 'ask which file',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: PROPOSED, title: 'Review a file' });
    const sent = complete.mock.calls[0][0];
    expect(sent.toolChoice).toEqual({ name: REFINE_PROMPT_TOOL });
    const text = sent.messages[0].content[0].text;
    expect(text).toContain('review the file');
    expect(text).toContain('ask which file');
    expect(text).toContain('code projects only');
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ subject: ME, purpose: 'prompt_refine', inputTokens: 120 })
    );
    expect(mockResolve).toHaveBeenCalledWith(null);
    expect(await listPrompts(libraryId)).toEqual([]);
  });

  it('drafts from a description when there is no draft', async () => {
    const libraryId = await newLibrary();
    const response = await ask(libraryId, { guidance: 'a prompt that plans a migration' });
    expect(response.status).toBe(200);
    const text = complete.mock.calls[0][0].messages[0].content[0].text;
    expect(text).toContain('There is no draft yet');
    expect(text).toContain('a prompt that plans a migration');
  });

  it('does not change a prompt the library already holds', async () => {
    const libraryId = await newLibrary();
    await createPrompt({ libraryId, title: 'Mine', body: 'original', subject: ME });
    await ask(libraryId, { body: 'original' });
    expect((await listPrompts(libraryId)).map((prompt) => prompt.body)).toEqual(['original']);
  });

  it('refuses when there is neither a draft nor a description, without asking the model', async () => {
    const libraryId = await newLibrary();
    const response = await ask(libraryId, { body: '   ', guidance: '  ' });
    expect(response.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses a model that is not on the roster', async () => {
    const libraryId = await newLibrary();
    const response = await ask(libraryId, { body: 'x', llmModelId: 'nope' });
    expect(response.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it('is not found for someone the library is not shared with', async () => {
    const libraryId = await newLibrary();
    mockGetSession.mockResolvedValue({ subject: 'mallory', roles: ['renkei-user'] });
    const response = await ask(libraryId, { body: 'x' });
    expect(response.status).toBe(404);
    expect(complete).not.toHaveBeenCalled();
  });

  it('is refused for a viewer, who cannot change the library', async () => {
    const libraryId = await newLibrary();
    await getDataStore().resourceGrants.upsert({
      resourceKind: 'prompt_library',
      resourceId: libraryId,
      ownerSubject: ME,
      granteeSubject: 'viewer-vic',
      role: 'viewer',
      expiresAt: null,
    });
    mockGetSession.mockResolvedValue({ subject: 'viewer-vic', roles: ['renkei-user'] });
    const response = await ask(libraryId, { body: 'x' });
    expect(response.status).toBe(403);
    expect(complete).not.toHaveBeenCalled();
  });

  it('says so when the model fails', async () => {
    const libraryId = await newLibrary();
    complete.mockResolvedValue({ ok: false, err: { type: 'server', message: 'boom' } });
    const response = await ask(libraryId, { body: 'x' });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/could not refine/);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('is refused for a person at their token limit, without asking the model', async () => {
    const id = await newLibrary();
    mockRefusal.mockResolvedValueOnce('You have reached the weekly token limit.');
    const response = await ask(id, { body: 'Review the file.' });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'token-limit' });
    expect(complete).not.toHaveBeenCalled();
  });
});

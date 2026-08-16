/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The OpenAI-spec adapter's promises: contract blocks translate to the
 * chat-completions dialect and back (tool_use ↔ tool_calls, tool_result ↔
 * role:'tool'), Azure's base-URL/deployment shape works, and HTTP statuses
 * land in the same error taxonomy the engine keys its behavior on.
 */

import { OpenAiProvider } from './openai';
import type { LlmRequest } from './contract';

const fetchSpy = jest.fn();
global.fetch = fetchSpy as unknown as typeof fetch;

const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5' });

const request: LlmRequest = {
  system: 'You are executing one step.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Do the thing.' }] }],
  tools: [
    {
      name: 'finish_step',
      description: 'Declare the outcome.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  toolChoice: 'any',
  maxTokens: 1024,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = {
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

beforeEach(() => {
  fetchSpy.mockReset();
});

describe('OpenAiProvider.complete', () => {
  it('sends the chat-completions shape with both auth headers', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, okBody));
    await provider.complete(request);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    // Bearer for OpenAI, api-key for Azure — each side ignores the other's.
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['api-key']).toBe('sk-test');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-5');
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are executing one step.' });
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'finish_step',
        description: 'Declare the outcome.',
        parameters: { type: 'object', properties: {} },
      },
    });
    expect(body.tool_choice).toBe('required');
  });

  it('targets an Azure AI Foundry base URL with the deployment as model', async () => {
    const azure = new OpenAiProvider({
      apiKey: 'azure-key',
      model: 'my-gpt5-deployment',
      baseUrl: 'https://myresource.openai.azure.com/openai/v1/',
    });
    fetchSpy.mockResolvedValue(jsonResponse(200, okBody));
    await azure.complete(request);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://myresource.openai.azure.com/openai/v1/chat/completions');
    expect(JSON.parse(String(init.body)).model).toBe('my-gpt5-deployment');
  });

  it('appends api-version when configured — the Azure route-versioning shape', async () => {
    const versioned = new OpenAiProvider({
      apiKey: 'azure-key',
      model: 'my-deployment',
      baseUrl: 'https://myresource.services.ai.azure.com/models',
      apiVersion: '2024-05-01-preview',
    });
    fetchSpy.mockResolvedValue(jsonResponse(200, okBody));
    await versioned.complete(request);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe(
      'https://myresource.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview'
    );
  });

  it('translates assistant tool_use and user tool_result onto the wire', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, okBody));
    await provider.complete({
      ...request,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Find it.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Calling now.' },
            { type: 'tool_use', id: 'call_1', name: 'jira_get_issue', input: { issueKey: 'P-1' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'found it' }],
        },
      ],
    });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: 'Calling now.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'jira_get_issue', arguments: '{"issueKey":"P-1"}' },
        },
      ],
    });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'found it' });
  });

  it('parses tool_calls responses back into tool_use blocks', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_9',
                  type: 'function',
                  function: { name: 'finish_step', arguments: '{"outcome":"success"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 42 },
      })
    );
    const result = await provider.complete(request);
    if (!result.ok) throw new Error('expected ok');
    expect(result.val.stopReason).toBe('tool_use');
    expect(result.val.content).toEqual([
      { type: 'tool_use', id: 'call_9', name: 'finish_step', input: { outcome: 'success' } },
    ]);
    expect(result.val.usage).toEqual({ inputTokens: 100, outputTokens: 42 });
  });

  it('treats broken tool-call JSON as an empty-args call, not a crash', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_x',
                  type: 'function',
                  function: { name: 'finish_step', arguments: '{oops' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    const result = await provider.complete(request);
    if (!result.ok) throw new Error('expected ok');
    expect(result.val.content).toEqual([
      { type: 'tool_use', id: 'call_x', name: 'finish_step', input: {} },
    ]);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [400, 'invalid_request'],
    // Azure's "no such deployment" — retrying can never fix it.
    [404, 'invalid_request'],
    [503, 'overloaded'],
    [500, 'provider_error'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    fetchSpy.mockResolvedValue(jsonResponse(status, { error: { message: 'nope' } }));
    const result = await provider.complete(request);
    if (result.ok) throw new Error('expected error');
    expect(result.err.type).toBe(kind);
  });

  it('maps an aborted request to timeout and a refused one to network', async () => {
    const timeoutError = new Error('timed out');
    timeoutError.name = 'TimeoutError';
    fetchSpy.mockRejectedValueOnce(timeoutError);
    const timedOut = await provider.complete(request);
    if (timedOut.ok) throw new Error('expected error');
    expect(timedOut.err.type).toBe('timeout');

    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const refused = await provider.complete(request);
    if (refused.ok) throw new Error('expected error');
    expect(refused.err.type).toBe('network');
  });
});

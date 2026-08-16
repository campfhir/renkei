/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The adapter's promises: request translation matches the Messages API,
 * response blocks come back typed, and HTTP statuses land in the error
 * taxonomy exactly — the engine's retry/abort behavior keys on the kind,
 * so a 429 mapped to provider_error would burn a user-visible attempt on
 * something backoff should have absorbed.
 */

import { AnthropicProvider } from './anthropic';
import type { LlmRequest } from './contract';

const fetchSpy = jest.fn();
global.fetch = fetchSpy as unknown as typeof fetch;

const provider = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-sonnet-5' });

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

beforeEach(() => {
  fetchSpy.mockReset();
});

describe('AnthropicProvider.complete', () => {
  it('sends the Messages API shape', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    );
    await provider.complete(request);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    // Anthropic-direct gets ONLY its own auth header — no Bearer, no api-key.
    expect(headers.authorization).toBeUndefined();
    expect(headers['api-key']).toBeUndefined();
    expect(headers['anthropic-version']).toBeDefined();
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(1024);
    expect(body.tools[0].input_schema).toEqual({ type: 'object', properties: {} });
    expect(body.tool_choice).toEqual({ type: 'any' });
  });

  it('renames tool_result blocks onto the wire', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { content: [], stop_reason: 'end_turn', usage: {} })
    );
    await provider.complete({
      ...request,
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'done', isError: true }],
        },
      ],
    });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'done',
      is_error: true,
    });
  });

  it('parses tool_use responses and usage', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        content: [
          { type: 'text', text: 'Calling now.' },
          { type: 'tool_use', id: 'tu_9', name: 'finish_step', input: { outcome: 'success' } },
          { type: 'thinking', thinking: 'dropped' },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 42 },
      })
    );
    const result = await provider.complete(request);
    if (!result.ok) throw new Error('expected ok');
    expect(result.val.stopReason).toBe('tool_use');
    expect(result.val.content).toEqual([
      { type: 'text', text: 'Calling now.' },
      { type: 'tool_use', id: 'tu_9', name: 'finish_step', input: { outcome: 'success' } },
    ]);
    expect(result.val.usage).toEqual({ inputTokens: 100, outputTokens: 42 });
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [400, 'invalid_request'],
    [413, 'invalid_request'],
    [529, 'overloaded'],
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

  it('appends api-version when configured — Azure Foundry Claude surfaces', async () => {
    const foundry = new AnthropicProvider({
      apiKey: 'azure-key',
      model: 'claude-sonnet-5',
      baseUrl: 'https://myresource.services.ai.azure.com/anthropic',
      apiVersion: '2023-05-01',
    });
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { content: [], stop_reason: 'end_turn', usage: {} })
    );
    await foundry.complete(request);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://myresource.services.ai.azure.com/anthropic/v1/messages?api-version=2023-05-01'
    );
    // Azure hosts get EXACTLY Foundry's curl headers — Bearer alone. Extra
    // credential headers make its gateway fail validation.
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer azure-key');
    expect(headers['api-key']).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends x-api-key plus Bearer to non-Azure gateways', async () => {
    const gateway = new AnthropicProvider({
      apiKey: 'gw-key',
      model: 'claude-sonnet-5',
      baseUrl: 'https://llm-gateway.example.com',
    });
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { content: [], stop_reason: 'end_turn', usage: {} })
    );
    await gateway.complete(request);
    const headers = (fetchSpy.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers['x-api-key']).toBe('gw-key');
    expect(headers.authorization).toBe('Bearer gw-key');
  });

  it('tolerates a pasted full endpoint as the base URL', async () => {
    const pasted = new AnthropicProvider({
      apiKey: 'azure-key',
      model: 'claude-sonnet-5',
      baseUrl: 'https://myresource.services.ai.azure.com/anthropic/v1/messages',
    });
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { content: [], stop_reason: 'end_turn', usage: {} })
    );
    await pasted.complete(request);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe(
      'https://myresource.services.ai.azure.com/anthropic/v1/messages'
    );
  });

  it('honours a base URL override', async () => {
    const proxied = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
      baseUrl: 'https://llm-gateway.example.com/',
    });
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { content: [], stop_reason: 'end_turn', usage: {} })
    );
    await proxied.complete(request);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe(
      'https://llm-gateway.example.com/v1/messages'
    );
  });
});

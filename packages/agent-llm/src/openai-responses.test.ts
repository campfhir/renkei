/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The Responses API adapter's promises: contract blocks translate to this
 * dialect's item shapes and back, the tool-call round trip (function_call
 * → function_call_output) works, and Azure's header rule still applies.
 *
 * The non-streaming fixtures below are real responses captured from a live
 * Azure gpt-6-astra-1 deployment during development (see openai-responses.ts's
 * module doc) — trimmed to the fields this adapter reads, not hand-written
 * from documentation.
 */

import { OpenAiResponsesProvider } from './openai-responses';
import type { LlmRequest } from './contract';

const fetchSpy = jest.fn();
global.fetch = fetchSpy as unknown as typeof fetch;

const provider = new OpenAiResponsesProvider({ apiKey: 'sk-test', model: 'gpt-6-astra-1' });

const request: LlmRequest = {
  system: 'You are executing one step.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in Seattle?' }] }],
  tools: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ],
  toolChoice: 'any',
  maxTokens: 512,
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

describe('OpenAiResponsesProvider.complete', () => {
  it('sends input items, flat tool defs, tool_choice required, and reasoning.effort', async () => {
    const reasoning = new OpenAiResponsesProvider({
      apiKey: 'sk-test',
      model: 'gpt-6-astra-1',
      reasoningEffort: 'medium',
    });
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        status: 'completed',
        output: [
          {
            id: 'fc_1',
            type: 'function_call',
            status: 'completed',
            arguments: '{"city":"Seattle"}',
            call_id: 'call_pfU2ZgAo9RhFNajU0AUll4Qd',
            name: 'get_weather',
          },
        ],
        usage: {
          input_tokens: 53,
          input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
          output_tokens: 18,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 71,
        },
      })
    );

    const result = await reasoning.complete(request);
    if (!result.ok) throw new Error(`expected ok, got ${result.err.type}`);
    expect(result.val).toEqual({
      content: [
        { type: 'tool_use', id: 'call_pfU2ZgAo9RhFNajU0AUll4Qd', name: 'get_weather', input: { city: 'Seattle' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 53, outputTokens: 18, cacheReadInputTokens: 0 },
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body: {
      model?: unknown;
      instructions?: unknown;
      input?: unknown;
      tools?: unknown;
      tool_choice?: unknown;
      reasoning?: unknown;
      max_output_tokens?: unknown;
    } = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-6-astra-1');
    expect(body.instructions).toBe('You are executing one step.');
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Seattle?' }] },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ]);
    expect(body.tool_choice).toBe('required');
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.max_output_tokens).toBe(512);
  });

  it('parses a plain-text answer from a message output item', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        status: 'completed',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', annotations: [], text: 'It’s 72°F and sunny in Seattle.' }],
          },
        ],
        usage: { input_tokens: 86, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } },
      })
    );
    const result = await provider.complete(request);
    if (!result.ok) throw new Error(`expected ok, got ${result.err.type}`);
    expect(result.val.content).toEqual([{ type: 'text', text: 'It’s 72°F and sunny in Seattle.' }]);
    expect(result.val.stopReason).toBe('end_turn');
  });

  it('round-trips a tool_use/tool_result history as function_call/function_call_output items', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'completed', output: [] }));
    await provider.complete({
      ...request,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is the weather in Seattle?' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_pfU2ZgAo9RhFNajU0AUll4Qd',
              name: 'get_weather',
              input: { city: 'Seattle' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_pfU2ZgAo9RhFNajU0AUll4Qd', content: '72F and sunny' },
          ],
        },
      ],
    });
    const body: { input?: unknown } = JSON.parse(
      String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body)
    );
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Seattle?' }] },
      {
        type: 'function_call',
        call_id: 'call_pfU2ZgAo9RhFNajU0AUll4Qd',
        name: 'get_weather',
        arguments: '{"city":"Seattle"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_pfU2ZgAo9RhFNajU0AUll4Qd',
        output: '72F and sunny',
      },
    ]);
  });

  it('sends Bearer alone on an Azure host', async () => {
    const azure = new OpenAiResponsesProvider({
      apiKey: 'azure-key',
      model: 'gpt-6-astra-1',
      baseUrl: 'https://myresource.openai.azure.com/openai/v1',
    });
    fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'completed', output: [] }));
    await azure.complete(request);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://myresource.openai.azure.com/openai/v1/responses');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer azure-key');
    expect(headers['api-key']).toBeUndefined();
  });

  it('sends both auth headers off Azure', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'completed', output: [] }));
    await provider.complete(request);
    const headers = (fetchSpy.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['api-key']).toBe('sk-test');
  });

  it('appends api-version when configured', async () => {
    const versioned = new OpenAiResponsesProvider({
      apiKey: 'azure-key',
      model: 'gpt-6-astra-1',
      baseUrl: 'https://myresource.openai.azure.com/openai/v1',
      apiVersion: '2024-05-01-preview',
    });
    fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'completed', output: [] }));
    await versioned.complete(request);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe(
      'https://myresource.openai.azure.com/openai/v1/responses?api-version=2024-05-01-preview'
    );
  });

  it('maps a 200 response with status "failed" to an error — this dialect fails IN the body', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        status: 'failed',
        output: [],
        error: { message: 'The model failed to produce a response.' },
      })
    );
    const result = await provider.complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.type).toBe('provider_error');
      expect(result.err.message).toContain('The model failed to produce a response.');
    }
  });

  it('reproduces the gpt-6-astra-1 contradiction as invalid_request from a 400', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message:
              "Function tools with reasoning_effort are not supported for gpt-6-astra-1 in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
            type: 'invalid_request_error',
            param: 'reasoning_effort',
          },
        }),
        { status: 400 }
      )
    );
    const result = await provider.complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('invalid_request');
  });

  it('maps a 401 to auth', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 401 }));
    const result = await provider.complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('auth');
  });

  it('maps a network failure to network', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    const result = await provider.complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('network');
  });
});

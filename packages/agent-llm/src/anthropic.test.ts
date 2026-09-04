/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The adapter's promises: request translation matches the Messages API,
 * response blocks come back typed, and HTTP statuses land in the error
 * taxonomy exactly — the engine's retry/abort behavior keys on the kind,
 * so a 429 mapped to provider_error would burn a user-visible attempt on
 * something backoff should have absorbed.
 */

import { AnthropicProvider, anthropicGeneration } from './anthropic';
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

describe('anthropicGeneration', () => {
  it.each([
    // The budget generation: enabled + budget_tokens, sampling allowed.
    ['claude-haiku-4-5', 'budget', false, true],
    ['claude-sonnet-4-5-20250929', 'budget', false, true],
    ['claude-opus-4-5@20251101', 'budget', false, true],
    ['claude-opus-4-1-20250805', 'budget', false, true],
    // A date suffix right after the major is not a minor version.
    ['claude-sonnet-4-20250514', 'budget', false, true],
    ['claude-3-5-sonnet-20241022', 'budget', false, true],
    // 4.6: adaptive, but sampling still allowed and text summarized by default.
    ['claude-opus-4-6', 'adaptive', false, true],
    ['claude-sonnet-4-6', 'adaptive', false, true],
    // 4.7 and later: adaptive only, display needed, no sampling.
    ['claude-opus-4-7', 'adaptive', true, false],
    ['claude-opus-4-8', 'adaptive', true, false],
    ['claude-opus-5', 'adaptive', true, false],
    ['claude-sonnet-5', 'adaptive', true, false],
    ['claude-fable-5-1', 'adaptive', true, false],
    ['claude-mythos-5-1', 'adaptive', true, false],
    // Vendor prefixes and context-window suffixes around the id.
    ['anthropic.claude-sonnet-5', 'adaptive', true, false],
    ['claude-opus-5[1m]', 'adaptive', true, false],
    ['Claude-Sonnet-5', 'adaptive', true, false],
    // A gateway deployment name that names no family: the oldest shape.
    ['my-chat-deployment', 'budget', false, true],
  ])('%s', (model, thinking, thinkingDisplay, sampling) => {
    expect(anthropicGeneration(model)).toEqual({ thinking, thinkingDisplay, sampling });
  });
});

describe('AnthropicProvider thinking by generation', () => {
  const okResponse = () =>
    jsonResponse(200, {
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  const thinkingRequest: LlmRequest = {
    ...request,
    toolChoice: 'auto',
    maxTokens: 8_000,
    temperature: 0.2,
    thinking: { budgetTokens: 4_000 },
  };
  const bodyOf = () =>
    JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));

  it('sends enabled + budget_tokens on the budget generation', async () => {
    fetchSpy.mockResolvedValue(okResponse());
    await new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-4-5' }).complete(
      thinkingRequest
    );
    const body = bodyOf();
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4_000 });
    // Thinking runs at temperature 1 only.
    expect(body.temperature).toBeUndefined();
  });

  it('sends adaptive without display on 4.6, where summarized is the default', async () => {
    fetchSpy.mockResolvedValue(okResponse());
    await new AnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-4-6' }).complete(
      thinkingRequest
    );
    const body = bodyOf();
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.temperature).toBeUndefined();
  });

  it('sends adaptive + summarized display on Sonnet 5, and no budget', async () => {
    // Without `display`, Sonnet 5 streams thinking blocks with empty text
    // and the chat shows an empty "Thought"; with a budget it 400s.
    fetchSpy.mockResolvedValue(okResponse());
    await new AnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-5' }).complete(
      thinkingRequest
    );
    const body = bodyOf();
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.thinking.budget_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('drops temperature on the newest generation even with thinking off', async () => {
    fetchSpy.mockResolvedValue(okResponse());
    await new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5' }).complete({
      ...request,
      temperature: 0.2,
    });
    const body = bodyOf();
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('keeps temperature on older generations with thinking off', async () => {
    fetchSpy.mockResolvedValue(okResponse());
    await new AnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-4-6' }).complete({
      ...request,
      temperature: 0.2,
    });
    expect(bodyOf().temperature).toBe(0.2);
  });

  it('still thinks in the open under a forced tool_choice, on every generation', async () => {
    fetchSpy.mockResolvedValue(okResponse());
    await new AnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-5' }).complete({
      ...thinkingRequest,
      toolChoice: 'any',
    });
    expect(bodyOf().thinking).toBeUndefined();
  });
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

  it('maps document and image blocks to base64 sources on the wire', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { content: [], stop_reason: 'end_turn', usage: {} })
    );
    await provider.complete({
      ...request,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mediaType: 'application/pdf',
              dataBase64: 'QUJD',
              title: 'report.pdf',
            },
            { type: 'image', mediaType: 'image/png', dataBase64: 'REVG' },
          ],
        },
      ],
    });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages[0].content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' },
      title: 'report.pdf',
    });
    expect(body.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'REVG' },
    });
  });

  it('parses tool_use responses and usage', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        content: [
          { type: 'text', text: 'Calling now.' },
          { type: 'tool_use', id: 'tu_9', name: 'finish_step', input: { outcome: 'success' } },
          { type: 'thinking', thinking: 'kept', signature: 'sig_1' },
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
      // Thinking survives the wire now that the chat renders it; the
      // engine ignores block types it has no use for.
      { type: 'thinking', thinking: 'kept', signature: 'sig_1' },
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
    // A gateway between us and the model (Azure, a proxy) speaks these, and
    // they mean the same thing 529 does: try again shortly.
    [502, 'overloaded'],
    [503, 'overloaded'],
    [504, 'overloaded'],
    [500, 'provider_error'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    fetchSpy.mockResolvedValue(jsonResponse(status, { error: { message: 'nope' } }));
    const result = await provider.complete(request);
    if (result.ok) throw new Error('expected error');
    expect(result.err.type).toBe(kind);
  });

  it('reads a credential failure as auth even when dressed as a 503', async () => {
    // The real shape of a broken org API key behind a gateway: the status
    // says "retry me", the body says the key is no good. Retrying a dead
    // credential burns one run per triggering event forever, and the run
    // blames the agent's step rather than the org's model settings.
    fetchSpy.mockResolvedValue(
      jsonResponse(503, { error: { message: 'credential validation failed' } })
    );
    const result = await provider.complete(request);
    if (result.ok) throw new Error('expected error');
    expect(result.err.type).toBe('auth');
  });

  it('still treats a plain 503 as retryable — the sniff is narrow on purpose', async () => {
    // The inverse mistake matters just as much: calling a transient fault
    // "auth" would abort runs that should have been retried.
    fetchSpy.mockResolvedValue(
      jsonResponse(503, { error: { message: 'upstream temporarily unavailable' } })
    );
    const result = await provider.complete(request);
    if (result.ok) throw new Error('expected error');
    expect(result.err.type).toBe('overloaded');
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

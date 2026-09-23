/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The "test connection" promise: a real completion call through the exact
 * adapter a saved config would use, so a wrong model id / deployment name
 * or an unreachable endpoint is caught here — not just a bad key, which
 * listAvailableModels already covers.
 */

import { testLlmConnection } from './test-connection';

const fetchSpy = jest.fn();
global.fetch = fetchSpy as unknown as typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchSpy.mockReset();
});

describe('testLlmConnection — anthropic', () => {
  it('sends a minimal completion and returns the reply', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 1 },
      })
    );
    const result = await testLlmConnection({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val).toEqual({ model: 'claude-sonnet-5', reply: 'ok' });
    }
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body: { model?: unknown; max_tokens?: unknown; messages?: unknown } = JSON.parse(
      init.body as string
    );
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(16);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('sends a tool definition and tool_choice auto — same shape a real chat turn sends', async () => {
    // A config that only breaks once tools are present (a reasoning model
    // that rejects tool_choice/temperature combos, a deployment with no
    // function-calling support at all) must fail HERE, not on the chat's
    // first real turn — see the module doc.
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    );
    await testLlmConnection({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-5' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body: { tools?: unknown; tool_choice?: unknown } = JSON.parse(init.body as string);
    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools as unknown[]).length).toBe(1);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('sends Azure hosts Bearer alone, honoring the draft base URL', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    );
    await testLlmConnection({
      provider: 'anthropic',
      apiKey: 'azure-key',
      model: 'my-claude-deployment',
      baseUrl: 'https://resource.services.ai.azure.com/anthropic',
      apiVersion: '2024-05-01-preview',
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/anthropic/v1/messages?api-version=2024-05-01-preview');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer azure-key');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('maps a rejected key to auth whatever the status says', async () => {
    fetchSpy.mockResolvedValue(new Response('credential validation failed', { status: 503 }));
    const result = await testLlmConnection({
      provider: 'anthropic',
      apiKey: 'sk-bad',
      model: 'claude-sonnet-5',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('auth');
  });

  it('surfaces a bad model/deployment name as invalid_request', async () => {
    fetchSpy.mockResolvedValue(
      new Response('{"error":{"type":"not_found_error","message":"model not found"}}', {
        status: 404,
      })
    );
    const result = await testLlmConnection({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'nonexistent-deployment',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('provider_error');
  });
});

describe('testLlmConnection — openai', () => {
  it('sends both auth headers and reports the reply', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      })
    );
    const result = await testLlmConnection({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toEqual({ model: 'gpt-5', reply: 'ok' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['api-key']).toBe('sk-test');
  });

  it('honors an Azure deployment name as the model id', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      })
    );
    await testLlmConnection({
      provider: 'openai',
      apiKey: 'azure-key',
      model: 'my-gpt-deployment',
      baseUrl: 'https://resource.openai.azure.com/openai/v1',
      apiVersion: '2024-05-01-preview',
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://resource.openai.azure.com/openai/v1/chat/completions?api-version=2024-05-01-preview'
    );
    const body: { model?: unknown } = JSON.parse(init.body as string);
    expect(body.model).toBe('my-gpt-deployment');
  });

  it('maps a 401 to auth', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 401 }));
    const result = await testLlmConnection({ provider: 'openai', apiKey: 'sk-bad', model: 'gpt-5' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('auth');
  });

  it('maps a 404 (no such deployment) to invalid_request', async () => {
    fetchSpy.mockResolvedValue(new Response('DeploymentNotFound', { status: 404 }));
    const result = await testLlmConnection({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'wrong-deployment',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('invalid_request');
  });

  it('apiSurface: "responses" tests against the Responses API adapter instead', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'completed', output: [] }));
    const result = await testLlmConnection({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-6-astra-1',
      apiSurface: 'responses',
    });
    expect(result.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body: { input?: unknown; messages?: unknown; tools?: unknown } = JSON.parse(
      String(init.body)
    );
    expect(body.messages).toBeUndefined();
    expect(Array.isArray(body.input)).toBe(true);
    // Still carries the tool-presence check the module doc explains.
    expect((body.tools as unknown[]).length).toBe(1);
  });

  it('sends a tool definition — catches a reasoning model that only fails once tools are present', async () => {
    // The gpt-6-astra-1 case this test exists for: no reasoning_effort was
    // ever configured, yet the deployment 400s the moment ANY tool
    // definition rides along, because its own default reasoning effort is
    // not "none". A toolless request would answer 200 and hide this.
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
    const result = await testLlmConnection({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-6-astra-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('invalid_request');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body: { tools?: unknown } = JSON.parse(init.body as string);
    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools as unknown[]).length).toBe(1);
  });
});

describe('testLlmConnection — edges', () => {
  it('refuses a provider it has no adapter for', async () => {
    const result = await testLlmConnection({ provider: 'gemini', apiKey: 'k', model: 'gemini-pro' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('unsupported_provider');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns an empty reply rather than failing when the model sends no text', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { content: [], stop_reason: 'end_turn' }));
    const result = await testLlmConnection({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.reply).toBe('');
  });

  it('maps a network failure to network', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    const result = await testLlmConnection({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('network');
  });
});

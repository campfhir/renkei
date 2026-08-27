/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The listing's promises: each dialect gets its own endpoint with the
 * adapter's exact auth headers (a key that completes must also list),
 * pagination is followed where the API has it, and errors land in the
 * taxonomy so the route can tell "bad key" from "provider down".
 */

import { listAvailableModels } from './models';

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

describe('listAvailableModels — anthropic', () => {
  it('asks /v1/models with the direct-Anthropic headers', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        data: [{ type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }],
        has_more: false,
      })
    );
    const result = await listAvailableModels({ provider: 'anthropic', apiKey: 'sk-test' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val).toEqual([{ id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' }]);
    }
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers.authorization).toBeUndefined();
    expect(headers['anthropic-version']).toBeDefined();
  });

  it('follows pagination by last_id', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [{ id: 'claude-a', display_name: 'A' }],
          has_more: true,
          last_id: 'claude-a',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [{ id: 'claude-b', display_name: 'B' }], has_more: false })
      );
    const result = await listAvailableModels({ provider: 'anthropic', apiKey: 'sk-test' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.map((m) => m.id)).toEqual(['claude-a', 'claude-b']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [secondUrl] = fetchSpy.mock.calls[1] as [string];
    expect(secondUrl).toContain('after_id=claude-a');
  });

  it('tolerates a stored base_url pasted as the full messages endpoint', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { data: [], has_more: false }));
    await listAvailableModels({
      provider: 'anthropic',
      apiKey: 'sk-test',
      baseUrl: 'https://gateway.example.com/v1/messages',
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example.com/v1/models?limit=1000');
    // A custom gateway gets both headers, same as the completion adapter.
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers.authorization).toBe('Bearer sk-test');
  });

  it('sends Azure hosts Bearer alone, with the api-version', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { data: [] }));
    await listAvailableModels({
      provider: 'anthropic',
      apiKey: 'azure-key',
      baseUrl: 'https://resource.services.ai.azure.com/anthropic',
      apiVersion: '2024-05-01-preview',
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/anthropic/v1/models?');
    expect(url).toContain('api-version=2024-05-01-preview');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer azure-key');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('maps a rejected key to auth whatever the status says', async () => {
    fetchSpy.mockResolvedValue(new Response('credential validation failed', { status: 503 }));
    const result = await listAvailableModels({ provider: 'anthropic', apiKey: 'sk-bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('auth');
  });
});

describe('listAvailableModels — openai', () => {
  it('asks {base}/models with both auth headers, sorted for scanning', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        object: 'list',
        data: [{ id: 'gpt-5' }, { id: 'dall-e-3' }, { id: 'gpt-5-mini' }],
      })
    );
    const result = await listAvailableModels({ provider: 'openai', apiKey: 'sk-test' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.map((m) => m.id)).toEqual(['dall-e-3', 'gpt-5', 'gpt-5-mini']);
      expect(result.val[0].displayName).toBeNull();
    }
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['api-key']).toBe('sk-test');
  });

  it('tolerates a base_url pasted as the chat-completions endpoint', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { data: [] }));
    await listAvailableModels({
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://resource.openai.azure.com/openai/v1/chat/completions',
    });
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('https://resource.openai.azure.com/openai/v1/models');
  });

  it('maps a 401 to auth', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 401 }));
    const result = await listAvailableModels({ provider: 'openai', apiKey: 'sk-bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('auth');
  });
});

describe('listAvailableModels — edges', () => {
  it('refuses a provider it has no listing for', async () => {
    const result = await listAvailableModels({ provider: 'gemini', apiKey: 'k' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('unsupported_provider');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('drops malformed rows rather than failing the list', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { data: [{ id: 'good' }, { display_name: 'no id' }, 'junk', null] })
    );
    const result = await listAvailableModels({ provider: 'openai', apiKey: 'sk-test' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toEqual([{ id: 'good', displayName: null }]);
  });

  it('maps an unparseable base URL to invalid_request instead of throwing', async () => {
    const result = await listAvailableModels({
      provider: 'anthropic',
      apiKey: 'sk-test',
      baseUrl: 'not a url',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('invalid_request');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a network failure to network', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    const result = await listAvailableModels({ provider: 'anthropic', apiKey: 'sk-test' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('network');
  });
});

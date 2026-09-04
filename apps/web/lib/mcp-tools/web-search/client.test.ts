/**
 * The Responses API contract: what goes on the wire (tool declaration,
 * location, filters, auth headers, endpoint tolerance) and how the answer
 * is read back — by item type, never by position.
 */

import { buildRequestBody, parseResponseOutput, responsesEndpoint, runWebSearch } from './client';
import type { WebSearchConfig } from './config';

const baseConfig: WebSearchConfig = {
  baseUrl: 'https://res.openai.azure.com/openai/v1',
  apiKey: 'azure-key',
  model: 'gpt-5.5',
  apiVersion: null,
  reasoningEffort: null,
  userLocation: null,
  allowedDomains: [],
  blockedDomains: [],
};

describe('responsesEndpoint', () => {
  it('appends /responses and tolerates a pasted full endpoint or trailing slash', () => {
    expect(responsesEndpoint(baseConfig)).toBe('https://res.openai.azure.com/openai/v1/responses');
    expect(responsesEndpoint({ ...baseConfig, baseUrl: `${baseConfig.baseUrl}/` })).toBe(
      'https://res.openai.azure.com/openai/v1/responses'
    );
    expect(responsesEndpoint({ ...baseConfig, baseUrl: `${baseConfig.baseUrl}/responses` })).toBe(
      'https://res.openai.azure.com/openai/v1/responses'
    );
    // Copied from the LLM-models page, which stores the chat surface's path.
    expect(
      responsesEndpoint({ ...baseConfig, baseUrl: `${baseConfig.baseUrl}/chat/completions` })
    ).toBe('https://res.openai.azure.com/openai/v1/responses');
  });

  it('adds ?api-version= only when configured', () => {
    expect(responsesEndpoint({ ...baseConfig, apiVersion: '2025-04-01-preview' })).toBe(
      'https://res.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview'
    );
  });
});

describe('buildRequestBody', () => {
  it('declares the web_search tool bare when nothing else is configured', () => {
    const body = buildRequestBody(baseConfig, {
      query: 'renewable energy trends',
      today: '2026-09-04',
    });
    expect(body.model).toBe('gpt-5.5');
    expect(body.input).toBe('renewable energy trends');
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.reasoning).toBeUndefined();
    expect(String(body.instructions)).toContain('2026-09-04');
  });

  it('carries the org location as an approximate user_location, and a per-call override wins', () => {
    const config = { ...baseConfig, userLocation: { country: 'US', city: 'Chicago' } };
    expect(buildRequestBody(config, { query: 'q' }).tools).toEqual([
      {
        type: 'web_search',
        user_location: { type: 'approximate', country: 'US', city: 'Chicago' },
      },
    ]);
    expect(
      buildRequestBody(config, { query: 'q', location: { country: 'GB', city: 'Leeds' } }).tools
    ).toEqual([
      { type: 'web_search', user_location: { type: 'approximate', country: 'GB', city: 'Leeds' } },
    ]);
  });

  it('sends domain filters and reasoning effort when configured', () => {
    const config = {
      ...baseConfig,
      reasoningEffort: 'low',
      allowedDomains: ['www.who.int'],
      blockedDomains: ['www.reddit.com'],
    };
    const body = buildRequestBody(config, { query: 'q' });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.tools).toEqual([
      {
        type: 'web_search',
        filters: { allowed_domains: ['www.who.int'], blocked_domains: ['www.reddit.com'] },
      },
    ]);
    // A caller's (already-narrowed) list replaces the org list on the wire.
    const narrowed = buildRequestBody(config, { query: 'q', allowedDomains: ['cdc.gov'] });
    const tool: { filters?: { allowed_domains?: string[] } } = Array.isArray(narrowed.tools)
      ? narrowed.tools[0]
      : {};
    expect(tool.filters?.allowed_domains).toEqual(['cdc.gov']);
  });
});

describe('parseResponseOutput', () => {
  it('reads the answer, citations, queries and sources by item type', () => {
    const result = parseResponseOutput({
      status: 'completed',
      output: [
        { id: 'rs_1', type: 'reasoning', summary: [] },
        {
          id: 'ws_1',
          type: 'web_search_call',
          status: 'completed',
          action: {
            type: 'search',
            query: 'latest renewable energy trends',
            sources: [{ type: 'url', url: 'https://example.org/a' }],
          },
        },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Solar led growth in 2025.',
              annotations: [
                { type: 'url_citation', url: 'https://example.org/a', title: 'Report A' },
                { type: 'url_citation', url: 'https://example.org/a', title: 'Report A' },
                { type: 'url_citation', url: 'https://example.org/b', title: '' },
              ],
            },
          ],
        },
      ],
    });
    expect(result.text).toBe('Solar led growth in 2025.');
    expect(result.searched).toBe(true);
    expect(result.queries).toEqual(['latest renewable energy trends']);
    expect(result.sources).toEqual(['https://example.org/a']);
    expect(result.citations).toEqual([
      { url: 'https://example.org/a', title: 'Report A' },
      { url: 'https://example.org/b', title: null },
    ]);
    expect(result.status).toBeNull();
  });

  it('reports a reply that never searched, and a non-completed status', () => {
    const result = parseResponseOutput({
      status: 'incomplete',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'From memory.' }] }],
    });
    expect(result.searched).toBe(false);
    expect(result.status).toBe('incomplete');
    expect(result.citations).toEqual([]);
  });

  it('survives junk', () => {
    expect(parseResponseOutput(null).text).toBe('');
    expect(parseResponseOutput({ output: 'nope' }).searched).toBe(false);
  });
});

describe('runWebSearch', () => {
  function fetchReturning(status: number, body: unknown) {
    return jest.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
    );
  }

  it('posts with both auth headers and returns the parsed answer', async () => {
    const fetchImpl = fetchReturning(200, {
      output: [
        { type: 'web_search_call', action: { type: 'search', query: 'q' } },
        { type: 'message', content: [{ type: 'output_text', text: 'Answer.' }] },
      ],
    });
    const outcome = await runWebSearch(baseConfig, { query: 'q' }, fetchImpl);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.val.text).toBe('Answer.');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://res.openai.azure.com/openai/v1/responses');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer azure-key');
    expect(headers.get('api-key')).toBe('azure-key');
    const sent: { tools?: unknown; input?: unknown } = JSON.parse(String(init.body));
    expect(sent.tools).toEqual([{ type: 'web_search' }]);
    expect(sent.input).toBe('q');
  });

  it('maps HTTP failures to kinds with the provider message', async () => {
    const cases: Array<[number, string]> = [
      [401, 'auth'],
      [403, 'auth'],
      [404, 'not_found'],
      [429, 'rate_limit'],
      [400, 'invalid_request'],
      [500, 'provider_error'],
    ];
    for (const [status, kind] of cases) {
      const outcome = await runWebSearch(
        baseConfig,
        { query: 'q' },
        fetchReturning(status, { error: { message: `boom ${status}` } })
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.kind).toBe(kind);
        expect(outcome.error.message).toContain(`boom ${status}`);
      }
    }
  });

  it('treats a 200 carrying an error object as a provider error', async () => {
    const outcome = await runWebSearch(
      baseConfig,
      { query: 'q' },
      fetchReturning(200, { error: { message: 'tool blocked' } })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('tool blocked');
  });

  it('reports a transport failure as network', async () => {
    const outcome = await runWebSearch(baseConfig, { query: 'q' }, async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('network');
  });
});

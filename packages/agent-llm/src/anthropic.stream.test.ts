/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The streaming path's promises: the Messages API's SSE vocabulary lands
 * on the contract's events one-to-one, the assembled result matches what
 * `complete` would return, thinking and prompt caching are requested the
 * way the API insists on, and cancel/timeout/error surface as their own
 * kinds rather than as a generic failure.
 */

import { AnthropicProvider } from './anthropic';
import type { LlmRequest, LlmStreamEvent } from './contract';

const fetchSpy = jest.fn();
global.fetch = fetchSpy as unknown as typeof fetch;

const provider = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-sonnet-5' });

const request: LlmRequest = {
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  tools: [
    { name: 'a_tool', description: 'A', inputSchema: { type: 'object' } },
    { name: 'b_tool', description: 'B', inputSchema: { type: 'object' } },
  ],
  maxTokens: 8000,
  temperature: 0.2,
};

function sse(frames: { event: string; data: unknown }[]): Response {
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const happyPath = [
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { usage: { input_tokens: 50, cache_read_input_tokens: 40, output_tokens: 1 } },
    },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Hmm.' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'a_tool', input: {} },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '"x"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
  { event: 'ping', data: { type: 'ping' } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 20 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

beforeEach(() => {
  fetchSpy.mockReset();
});

describe('AnthropicProvider.stream', () => {
  it('emits contract events and resolves with the assembled response', async () => {
    fetchSpy.mockResolvedValue(sse(happyPath));
    const events: LlmStreamEvent[] = [];
    const result = await provider.stream(request, { onEvent: (e) => events.push(e) });
    if (!result.ok) throw new Error(`expected ok, got ${result.err.type}`);

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'block_start',
      'thinking_delta',
      'signature_delta',
      'block_stop',
      'block_start',
      'text_delta',
      'text_delta',
      'block_stop',
      'block_start',
      'input_json_delta',
      'input_json_delta',
      'block_stop',
      'message_end',
    ]);
    expect(result.val).toEqual({
      content: [
        { type: 'thinking', thinking: 'Hmm.', signature: 'sig' },
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tu_1', name: 'a_tool', input: { q: 'x' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 50, outputTokens: 20, cacheReadInputTokens: 40 },
    });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.stream).toBe(true);
  });

  it('requests thinking and prompt caching the way the API insists on', async () => {
    fetchSpy.mockResolvedValue(sse(happyPath));
    await provider.stream(
      { ...request, thinking: { budgetTokens: 100_000 }, promptCache: true },
      { onEvent: () => {} }
    );
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    // Budget clamped under max_tokens, temperature dropped alongside thinking.
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 - 1024 });
    expect(body.temperature).toBeUndefined();
    expect(body.system).toEqual([
      { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits thinking when max_tokens cannot hold it or a tool is forced', async () => {
    fetchSpy.mockResolvedValue(sse(happyPath));
    await provider.stream(
      { ...request, maxTokens: 1500, thinking: { budgetTokens: 4000 } },
      {
        onEvent: () => {},
      }
    );
    let body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.2);

    fetchSpy.mockResolvedValue(sse(happyPath));
    await provider.stream(
      { ...request, toolChoice: 'any', thinking: { budgetTokens: 4000 } },
      {
        onEvent: () => {},
      }
    );
    body = JSON.parse(String((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body));
    expect(body.thinking).toBeUndefined();
  });

  it('echoes signed thinking blocks and drops unsigned ones on the wire', async () => {
    fetchSpy.mockResolvedValue(sse(happyPath));
    await provider.stream(
      {
        ...request,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'signed', signature: 'sig' },
              { type: 'thinking', thinking: 'unsigned' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: 'ok' },
            ],
          },
        ],
      },
      { onEvent: () => {} }
    );
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'signed', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'ok' },
    ]);
  });

  it('maps a mid-stream error event to its kind', async () => {
    fetchSpy.mockResolvedValue(
      sse([
        happyPath[0],
        {
          event: 'error',
          data: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
        },
      ])
    );
    const result = await provider.stream(request, { onEvent: () => {} });
    if (result.ok) throw new Error('expected error');
    expect(result.err.type).toBe('overloaded');
  });

  it("reports the caller's abort as 'aborted' and a cut stream as provider_error", async () => {
    const controller = new AbortController();
    fetchSpy.mockImplementation(() => {
      controller.abort();
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      return Promise.reject(abort);
    });
    const aborted = await provider.stream(request, {
      onEvent: () => {},
      signal: controller.signal,
    });
    if (aborted.ok) throw new Error('expected error');
    expect(aborted.err.type).toBe('aborted');

    fetchSpy.mockResolvedValue(sse(happyPath.slice(0, 8)));
    const cut = await provider.stream(request, { onEvent: () => {} });
    if (cut.ok) throw new Error('expected error');
    expect(cut.err.type).toBe('provider_error');
  });

  it('maps a non-2xx before the stream to the usual taxonomy', async () => {
    fetchSpy.mockResolvedValue(new Response('{"error":{"message":"slow down"}}', { status: 429 }));
    const result = await provider.stream(request, { onEvent: () => {} });
    if (result.ok) throw new Error('expected error');
    expect(result.err.type).toBe('rate_limit');
  });
});

/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The chat-completions streaming path: text, reasoning and tool-call
 * deltas land on fixed content indices, tool arguments are accumulated
 * by the dialect's own per-call index, the usage-only trailer is read,
 * `[DONE]` ends the stream, and the legacy max_tokens retry still runs
 * before any bytes are streamed.
 */

import { OpenAiProvider } from './openai';
import type { LlmRequest, LlmStreamEvent } from './contract';

const fetchSpy = jest.fn();
global.fetch = fetchSpy as unknown as typeof fetch;

const request: LlmRequest = {
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  tools: [{ name: 'a_tool', description: 'A', inputSchema: { type: 'object' } }],
  maxTokens: 2000,
};

function sse(chunks: unknown[]): Response {
  const text =
    chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('') +
    'data: [DONE]\n\n';
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function delta(delta: Record<string, unknown>, finish: string | null = null): unknown {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}

beforeEach(() => {
  fetchSpy.mockReset();
});

describe('OpenAiProvider.stream', () => {
  it('streams text, reasoning and tool calls into indexed blocks', async () => {
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'gpt-x' });
    fetchSpy.mockResolvedValue(
      sse([
        delta({ role: 'assistant', reasoning_content: 'Thinking ' }),
        delta({ reasoning_content: 'hard.' }),
        delta({ content: 'Sure' }),
        delta({ content: '!' }),
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'a_tool', arguments: '' },
            },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
        delta({}, 'tool_calls'),
        {
          choices: [],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 12,
            prompt_tokens_details: { cached_tokens: 10 },
          },
        },
      ])
    );
    const events: LlmStreamEvent[] = [];
    const result = await provider.stream(request, { onEvent: (e) => events.push(e) });
    if (!result.ok) throw new Error(`expected ok, got ${result.err.type}`);

    expect(result.val).toEqual({
      content: [
        { type: 'text', text: 'Sure!' },
        { type: 'thinking', thinking: 'Thinking hard.' },
        { type: 'tool_use', id: 'call_1', name: 'a_tool', input: { q: 'x' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 10 },
    });
    expect(events[0]).toEqual({ type: 'message_start' });
    expect(events.filter((e) => e.type === 'block_start').length).toBe(3);
    expect(events.filter((e) => e.type === 'block_stop').length).toBe(3);
    expect(events[events.length - 1].type).toBe('message_end');

    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_completion_tokens).toBe(2000);
  });

  it('retries once with max_tokens before streaming when the endpoint rejects the modern name', async () => {
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'legacy' });
    fetchSpy
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"Unsupported parameter: max_completion_tokens"}}', {
          status: 400,
        })
      )
      .mockResolvedValueOnce(sse([delta({ content: 'ok' }, 'stop')]));
    const result = await provider.stream(request, { onEvent: () => {} });
    if (!result.ok) throw new Error('expected ok');
    expect(result.val.content).toEqual([{ type: 'text', text: 'ok' }]);
    const second = JSON.parse(String((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body));
    expect(second.max_tokens).toBe(2000);
    expect(second.max_completion_tokens).toBeUndefined();
  });

  it('treats [DONE] without a finish_reason as end_turn and closes open blocks', async () => {
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'gw' });
    fetchSpy.mockResolvedValue(sse([delta({ content: 'partial' })]));
    const events: LlmStreamEvent[] = [];
    const result = await provider.stream(request, { onEvent: (e) => events.push(e) });
    if (!result.ok) throw new Error('expected ok');
    expect(result.val.stopReason).toBe('end_turn');
    expect(events.some((e) => e.type === 'block_stop')).toBe(true);
  });

  it('surfaces a stream that ends without [DONE] or a finish as provider_error', async () => {
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'gw' });
    fetchSpy.mockResolvedValue(
      new Response(`data: ${JSON.stringify(delta({ content: 'x' }))}\n\n`, { status: 200 })
    );
    const result = await provider.stream(request, { onEvent: () => {} });
    if (result.ok) throw new Error('expected error');
    expect(result.err.type).toBe('provider_error');
  });

  it('drops thinking blocks from assistant history on the wire', async () => {
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'gpt-x' });
    fetchSpy.mockResolvedValue(sse([delta({ content: 'ok' }, 'stop')]));
    await provider.stream(
      {
        ...request,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'secret', signature: 'sig' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      },
      { onEvent: () => {} }
    );
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'answer' });
  });
});

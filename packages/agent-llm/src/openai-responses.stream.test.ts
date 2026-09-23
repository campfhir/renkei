/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The Responses API streaming path. The tool-call event sequence
 * (`response.created` → `output_item.added` → `function_call_arguments.delta`
 * ×N → `.done` → `output_item.done` → `response.completed`) below is the
 * REAL SSE trace captured from a live Azure gpt-6-astra-1 deployment
 * (trimmed to the lines this adapter reads), not written from
 * documentation — see openai-responses.ts's module doc. The text-delta
 * path has no equivalent real capture (every sample taken emitted a tool
 * call, never plain text over streaming) and is exercised here from the
 * same event family by inference.
 */

import { OpenAiResponsesProvider } from './openai-responses';
import type { LlmRequest, LlmStreamEvent } from './contract';

const fetchSpy = jest.fn();
global.fetch = fetchSpy as unknown as typeof fetch;

const request: LlmRequest = {
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in Seattle?' }] }],
  tools: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
    },
  ],
  toolChoice: 'any',
  maxTokens: 512,
};

function sse(events: { event: string; data: unknown }[]): Response {
  const text = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  fetchSpy.mockReset();
});

describe('OpenAiResponsesProvider.stream', () => {
  it('streams a forced tool call into one indexed block — the real captured trace', async () => {
    const provider = new OpenAiResponsesProvider({ apiKey: 'k', model: 'gpt-6-astra-1' });
    fetchSpy.mockResolvedValue(
      sse([
        {
          event: 'response.created',
          data: { type: 'response.created', response: { status: 'in_progress' }, sequence_number: 0 },
        },
        {
          event: 'response.in_progress',
          data: { type: 'response.in_progress', response: { status: 'in_progress' }, sequence_number: 1 },
        },
        {
          event: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'in_progress',
              arguments: '',
              call_id: 'call_sQQ0Yj0Qtfb4SP5HFtSlC7Of',
              name: 'get_weather',
            },
            output_index: 0,
            sequence_number: 2,
          },
        },
        {
          event: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            delta: '{"',
            item_id: 'fc_1',
            output_index: 0,
            sequence_number: 3,
          },
        },
        {
          event: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            delta: 'city',
            item_id: 'fc_1',
            output_index: 0,
            sequence_number: 4,
          },
        },
        {
          event: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            delta: '":"',
            item_id: 'fc_1',
            output_index: 0,
            sequence_number: 5,
          },
        },
        {
          event: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            delta: 'Seattle',
            item_id: 'fc_1',
            output_index: 0,
            sequence_number: 6,
          },
        },
        {
          event: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            delta: '"}',
            item_id: 'fc_1',
            output_index: 0,
            sequence_number: 7,
          },
        },
        {
          event: 'response.function_call_arguments.done',
          data: {
            type: 'response.function_call_arguments.done',
            arguments: '{"city":"Seattle"}',
            item_id: 'fc_1',
            output_index: 0,
            sequence_number: 8,
          },
        },
        {
          event: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'completed',
              arguments: '{"city":"Seattle"}',
              call_id: 'call_sQQ0Yj0Qtfb4SP5HFtSlC7Of',
              name: 'get_weather',
            },
            output_index: 0,
            sequence_number: 9,
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  id: 'fc_1',
                  type: 'function_call',
                  status: 'completed',
                  arguments: '{"city":"Seattle"}',
                  call_id: 'call_sQQ0Yj0Qtfb4SP5HFtSlC7Of',
                  name: 'get_weather',
                },
              ],
              usage: { input_tokens: 53, output_tokens: 18 },
            },
            sequence_number: 10,
          },
        },
      ])
    );

    const events: LlmStreamEvent[] = [];
    const result = await provider.stream(request, { onEvent: (e) => events.push(e) });
    if (!result.ok) throw new Error(`expected ok, got ${result.err.type}`);

    expect(result.val).toEqual({
      content: [
        {
          type: 'tool_use',
          id: 'call_sQQ0Yj0Qtfb4SP5HFtSlC7Of',
          name: 'get_weather',
          input: { city: 'Seattle' },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 53, outputTokens: 18 },
    });
    expect(events[0]).toEqual({ type: 'message_start' });
    expect(events.filter((e) => e.type === 'block_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'block_stop')).toHaveLength(1);
    expect(events[events.length - 1].type).toBe('message_end');

    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.stream).toBe(true);
  });

  it('streams plain text into one block (inferred shape — no real capture)', async () => {
    const provider = new OpenAiResponsesProvider({ apiKey: 'k', model: 'gpt-5' });
    fetchSpy.mockResolvedValue(
      sse([
        {
          event: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
            output_index: 0,
            sequence_number: 0,
          },
        },
        {
          event: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            delta: 'Sure',
            item_id: 'msg_1',
            output_index: 0,
            sequence_number: 1,
          },
        },
        {
          event: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            delta: '!',
            item_id: 'msg_1',
            output_index: 0,
            sequence_number: 2,
          },
        },
        {
          event: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            item: { id: 'msg_1', type: 'message', status: 'completed' },
            output_index: 0,
            sequence_number: 3,
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2 } },
            sequence_number: 4,
          },
        },
      ])
    );
    const events: LlmStreamEvent[] = [];
    const result = await provider.stream(request, { onEvent: (e) => events.push(e) });
    if (!result.ok) throw new Error(`expected ok, got ${result.err.type}`);
    expect(result.val.content).toEqual([{ type: 'text', text: 'Sure!' }]);
    expect(result.val.stopReason).toBe('end_turn');
  });

  it('maps a response.failed event to an error', async () => {
    const provider = new OpenAiResponsesProvider({ apiKey: 'k', model: 'gpt-6-astra-1' });
    fetchSpy.mockResolvedValue(
      sse([
        {
          event: 'response.failed',
          data: {
            type: 'response.failed',
            response: { status: 'failed', error: { message: 'The model failed to produce a response.' } },
            sequence_number: 0,
          },
        },
      ])
    );
    const result = await provider.stream(request, { onEvent: () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.type).toBe('provider_error');
      expect(result.err.message).toContain('The model failed to produce a response.');
    }
  });

  it('ends the stream as an error if it stops before response.completed', async () => {
    const provider = new OpenAiResponsesProvider({ apiKey: 'k', model: 'gpt-6-astra-1' });
    fetchSpy.mockResolvedValue(
      sse([
        {
          event: 'response.created',
          data: { type: 'response.created', response: { status: 'in_progress' }, sequence_number: 0 },
        },
      ])
    );
    const result = await provider.stream(request, { onEvent: () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('provider_error');
  });
});

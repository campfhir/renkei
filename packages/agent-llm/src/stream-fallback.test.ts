/**
 * streamOrComplete's promise: a provider with only `complete()` still
 * produces the full event sequence, and one with `stream()` is used as-is.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { streamOrComplete } from './stream-fallback';
import type { LlmProvider, LlmRequest, LlmStreamEvent } from './contract';

const request: LlmRequest = {
  system: 's',
  messages: [],
  tools: [],
  maxTokens: 10,
};

describe('streamOrComplete', () => {
  it('replays a completed response as events when the provider cannot stream', async () => {
    const provider: LlmProvider = {
      complete: async () =>
        ok({
          content: [
            { type: 'thinking', thinking: 'why', signature: 'sig' },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 2 },
        }),
    };
    const events: LlmStreamEvent[] = [];
    const result = await streamOrComplete(provider, request, { onEvent: (e) => events.push(e) });
    if (!result.ok) throw new Error('expected ok');
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'block_start',
      'thinking_delta',
      'signature_delta',
      'block_stop',
      'block_start',
      'text_delta',
      'block_stop',
      'block_start',
      'block_stop',
      'message_end',
    ]);
    expect(result.val.content[2]).toEqual({
      type: 'tool_use',
      id: 't1',
      name: 'x',
      input: { a: 1 },
    });
  });

  it('passes errors through untouched', async () => {
    const provider: LlmProvider = {
      complete: async () => err('rate_limit' as const, { message: 'slow' }),
    };
    const result = await streamOrComplete(provider, request, { onEvent: () => {} });
    if (result.ok) throw new Error('expected error');
    expect(result.err.type).toBe('rate_limit');
  });

  it('prefers the provider stream when present', async () => {
    const stream = jest.fn(async () =>
      ok({
        content: [],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      })
    );
    const provider: LlmProvider = {
      complete: async () => {
        throw new Error('should not be called');
      },
      stream,
    };
    await streamOrComplete(provider, request, { onEvent: () => {} });
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

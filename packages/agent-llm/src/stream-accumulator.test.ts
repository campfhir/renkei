/**
 * The accumulator's promise: any interleaving of events reassembles into
 * the response a request/response call would have returned — blocks in
 * index order, tool input parsed once complete, broken input tolerated.
 */

import { createAccumulator } from './stream-accumulator';

describe('createAccumulator', () => {
  it('assembles interleaved text, thinking and tool blocks by index', () => {
    const acc = createAccumulator();
    acc.apply({ type: 'message_start', usage: { inputTokens: 12, cacheReadInputTokens: 4 } });
    acc.apply({ type: 'block_start', index: 0, block: { type: 'thinking', thinking: '' } });
    acc.apply({ type: 'block_start', index: 1, block: { type: 'text', text: '' } });
    acc.apply({
      type: 'block_start',
      index: 2,
      block: { type: 'tool_use', id: 'tu_1', name: 'jira_search_issues', input: {} },
    });
    acc.apply({ type: 'thinking_delta', index: 0, thinking: 'Let me ' });
    acc.apply({ type: 'text_delta', index: 1, text: 'Searching' });
    acc.apply({ type: 'input_json_delta', index: 2, partialJson: '{"jql":' });
    acc.apply({ type: 'thinking_delta', index: 0, thinking: 'look.' });
    acc.apply({ type: 'signature_delta', index: 0, signature: 'sig' });
    acc.apply({ type: 'text_delta', index: 1, text: '...' });
    acc.apply({ type: 'input_json_delta', index: 2, partialJson: '"a=b"}' });
    acc.apply({ type: 'block_stop', index: 2 });
    acc.apply({ type: 'block_stop', index: 0 });
    acc.apply({ type: 'block_stop', index: 1 });
    acc.apply({
      type: 'message_end',
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 30 },
    });

    expect(acc.response()).toEqual({
      content: [
        { type: 'thinking', thinking: 'Let me look.', signature: 'sig' },
        { type: 'text', text: 'Searching...' },
        { type: 'tool_use', id: 'tu_1', name: 'jira_search_issues', input: { jql: 'a=b' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 30, cacheReadInputTokens: 4 },
    });
  });

  it('parses unfinished or broken tool input as an empty object', () => {
    const acc = createAccumulator();
    acc.apply({
      type: 'block_start',
      index: 0,
      block: { type: 'tool_use', id: 'tu_1', name: 'x', input: {} },
    });
    acc.apply({ type: 'input_json_delta', index: 0, partialJson: '{"cut' });
    // No block_stop: the stream was interrupted.
    expect(acc.blocks()).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'x', input: {} }]);
  });

  it('keeps a tool_use skeleton input when no JSON deltas arrive', () => {
    const acc = createAccumulator();
    acc.apply({
      type: 'block_start',
      index: 0,
      block: { type: 'tool_use', id: 'tu_1', name: 'x', input: { ready: true } },
    });
    acc.apply({ type: 'block_stop', index: 0 });
    expect(acc.blocks()[0]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'x',
      input: { ready: true },
    });
  });

  it('passes redacted_thinking through untouched and defaults stopReason to end_turn', () => {
    const acc = createAccumulator();
    acc.apply({
      type: 'block_start',
      index: 0,
      block: { type: 'redacted_thinking', data: 'opaque' },
    });
    acc.apply({ type: 'block_stop', index: 0 });
    expect(acc.response()).toEqual({
      content: [{ type: 'redacted_thinking', data: 'opaque' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});

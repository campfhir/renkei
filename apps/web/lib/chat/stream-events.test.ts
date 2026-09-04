import { applyStreamEvent, initialThreadState, type ChatStreamEvent } from './stream-events';
import type { ChatMessageView } from './views';

const start = (messageId: string, seq: number): ChatStreamEvent => ({
  type: 'message_start',
  messageId,
  turnId: 'turn',
  seq,
  role: 'assistant',
  kind: 'assistant',
  llmModelId: null,
  provider: null,
  model: null,
  createdAt: '2026-09-04T00:00:00.000Z',
});

function reduce(events: ChatStreamEvent[], initial = initialThreadState([], null)) {
  return events.reduce(applyStreamEvent, initial);
}

describe('applyStreamEvent', () => {
  it('builds a message from deltas and closes it', () => {
    const state = reduce([
      start('a', 2),
      { type: 'block_start', messageId: 'a', index: 0, block: { type: 'thinking', thinking: '' } },
      { type: 'thinking_delta', messageId: 'a', index: 0, thinking: 'hm' },
      { type: 'block_start', messageId: 'a', index: 1, block: { type: 'text', text: '' } },
      { type: 'text_delta', messageId: 'a', index: 1, text: 'Hel' },
      { type: 'text_delta', messageId: 'a', index: 1, text: 'lo' },
      {
        type: 'block_start',
        messageId: 'a',
        index: 2,
        block: { type: 'tool_use', id: 't', name: 'x', input: {} },
      },
      { type: 'input_json_delta', messageId: 'a', index: 2, partialJson: '{"a":' },
      { type: 'input_json_delta', messageId: 'a', index: 2, partialJson: '1}' },
      {
        type: 'block_stop',
        messageId: 'a',
        index: 2,
        block: { type: 'tool_use', id: 't', name: 'x', input: { a: 1 } },
      },
      {
        type: 'message_end',
        messageId: 'a',
        status: 'complete',
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 2 },
        error: null,
      },
    ]);
    expect(state.messages).toHaveLength(1);
    const message = state.messages[0];
    expect(message.status).toBe('complete');
    expect(message.blocks).toEqual([
      { type: 'thinking', thinking: 'hm' },
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 't', name: 'x', input: { a: 1 } },
    ]);
  });

  it('keeps partial JSON visible while a tool call streams', () => {
    const state = reduce([
      start('a', 1),
      {
        type: 'block_start',
        messageId: 'a',
        index: 0,
        block: { type: 'tool_use', id: 't', name: 'x', input: {} },
      },
      { type: 'input_json_delta', messageId: 'a', index: 0, partialJson: '{"q":"' },
    ]);
    expect(state.messages[0].blocks[0]).toEqual({
      type: 'tool_use',
      id: 't',
      name: 'x',
      input: {},
      partialJson: '{"q":"',
    });
  });

  it('ignores a duplicate message_start and orders messages by seq', () => {
    const state = reduce([start('b', 5), start('a', 3), start('b', 5)]);
    expect(state.messages.map((message) => message.id)).toEqual(['a', 'b']);
  });

  it('replaces the turn on a snapshot and keeps other turns', () => {
    const other: ChatMessageView = {
      id: 'old',
      turnId: 'earlier',
      seq: 1,
      role: 'user',
      kind: 'prompt',
      status: 'complete',
      blocks: [{ type: 'text', text: 'hi' }],
      llmModelId: null,
      provider: null,
      model: null,
      stopReason: null,
      usage: null,
      error: null,
      createdAt: '2026-09-04T00:00:00.000Z',
      attachments: [],
    };
    const initial = initialThreadState([other], null);
    const state = reduce(
      [
        start('a', 2),
        {
          type: 'snapshot',
          turn: { id: 'turn', status: 'running', error: null, startedAt: 'x', finishedAt: null },
          messages: [{ ...other, id: 'a2', turnId: 'turn', seq: 2 }],
        },
      ],
      initial
    );
    expect(state.messages.map((message) => message.id)).toEqual(['old', 'a2']);
    expect(state.turn?.status).toBe('running');
  });

  it('marks still-streaming messages with the turn outcome on turn_end', () => {
    const state = reduce([
      start('a', 1),
      { type: 'turn_end', turnId: 'turn', status: 'interrupted', error: 'gone' },
    ]);
    expect(state.messages[0].status).toBe('interrupted');
    expect(state.turn?.status).toBe('interrupted');
    expect(state.turn?.error).toBe('gone');
  });
});

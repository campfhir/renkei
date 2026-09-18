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

  it('keeps the partial JSON, not a lying empty input, when the turn ends before block_stop', () => {
    // A timeout/error/cancel ends the message while a tool call's
    // arguments are still streaming — turn-runner.ts's finalize() emits
    // message_end straight away, with no block_stop for that block. The
    // reducer must not synthesize `input` from the block_start placeholder.
    const state = reduce([
      start('a', 1),
      {
        type: 'block_start',
        messageId: 'a',
        index: 0,
        block: { type: 'tool_use', id: 't', name: 'agent_patch_steps', input: {} },
      },
      { type: 'input_json_delta', messageId: 'a', index: 0, partialJson: '{"agentId": "ID"' },
      {
        type: 'message_end',
        messageId: 'a',
        status: 'interrupted',
        stopReason: null,
        usage: null,
        error: 'The reply stopped unexpectedly and did not finish.',
      },
    ]);
    expect(state.messages[0].status).toBe('interrupted');
    expect(state.messages[0].blocks[0]).toEqual({
      type: 'tool_use',
      id: 't',
      name: 'agent_patch_steps',
      input: {},
      partialJson: '{"agentId": "ID"',
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
          turn: {
            id: 'turn',
            status: 'running',
            kind: 'reply',
            error: null,
            startedAt: 'x',
            finishedAt: null,
          },
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

  it('lists a produced file once, and drops it with the rows a resend removes', () => {
    const artifact = {
      id: 'f1',
      filename: 'shot.png',
      contentType: 'image/png',
      sizeBytes: 10,
      extractStatus: 'none',
    };
    const withFile = reduce([
      start('p', 1),
      start('a', 2),
      { type: 'artifact', messageId: 'a', attachment: artifact },
      { type: 'artifact', messageId: 'a', attachment: artifact },
    ]);
    expect(withFile.artifacts).toEqual([artifact]);
    expect(withFile.messages.map((message) => message.id)).toEqual(['p', 'a']);

    const truncated = applyStreamEvent(withFile, {
      type: 'truncate',
      fromSeq: 2,
      removedArtifactIds: ['f1'],
    });
    expect(truncated.messages.map((message) => message.id)).toEqual(['p']);
    expect(truncated.artifacts).toEqual([]);
    expect(truncated.turn).toBeNull();
  });

  it('tracks a compaction pass live, then marks it done on its own turn_end', () => {
    const running = reduce([
      { type: 'compaction_progress', turnId: 'ct', foldedSoFar: 0, totalToFold: 50 },
      { type: 'compaction_progress', turnId: 'ct', foldedSoFar: 25, totalToFold: 50 },
    ]);
    expect(running.compaction).toEqual({
      turnId: 'ct',
      status: 'running',
      foldedSoFar: 25,
      totalToFold: 50,
    });

    const done = applyStreamEvent(running, {
      type: 'turn_end',
      turnId: 'ct',
      status: 'completed',
      error: null,
    });
    expect(done.compaction).toEqual({
      turnId: 'ct',
      status: 'done',
      foldedSoFar: 25,
      totalToFold: 50,
    });

    const failed = applyStreamEvent(running, {
      type: 'turn_end',
      turnId: 'ct',
      status: 'failed',
      error: 'model unavailable',
    });
    expect(failed.compaction?.status).toBe('failed');
  });

  it('leaves compaction alone when turn_end belongs to a different turn', () => {
    const state = reduce([
      { type: 'compaction_progress', turnId: 'ct', foldedSoFar: 5, totalToFold: 10 },
      { type: 'turn_end', turnId: 'some-other-turn', status: 'completed', error: null },
    ]);
    expect(state.compaction).toEqual({
      turnId: 'ct',
      status: 'running',
      foldedSoFar: 5,
      totalToFold: 10,
    });
  });

  it('reconnecting mid-compaction (a snapshot on a compaction turn) shows it running with no counts yet', () => {
    const state = reduce([
      {
        type: 'snapshot',
        turn: {
          id: 'ct',
          status: 'running',
          kind: 'compaction',
          error: null,
          startedAt: 'x',
          finishedAt: null,
        },
        messages: [],
      },
    ]);
    expect(state.compaction).toEqual({
      turnId: 'ct',
      status: 'running',
      foldedSoFar: 0,
      totalToFold: 0,
    });
  });

  it('clears compaction on truncate', () => {
    const state = reduce([
      { type: 'compaction_progress', turnId: 'ct', foldedSoFar: 1, totalToFold: 2 },
    ]);
    const truncated = applyStreamEvent(state, {
      type: 'truncate',
      fromSeq: 1,
      removedArtifactIds: [],
    });
    expect(truncated.compaction).toBeNull();
  });
});

describe('tool permission events', () => {
  const permission = {
    toolUseId: 'tu_1',
    messageId: 'a',
    name: 'jira_create_issue',
    requestedAt: '2026-09-04T00:00:00.000Z',
  };

  it('holds the ask from request to decision', () => {
    const asked = reduce([
      start('a', 2),
      { type: 'tool_permission_request', turnId: 'turn', permission },
    ]);
    expect(asked.pendingPermission).toEqual(permission);
    const other = applyStreamEvent(asked, {
      type: 'tool_permission_decided',
      turnId: 'turn',
      toolUseId: 'tu_other',
      decision: 'once',
    });
    expect(other.pendingPermission).toEqual(permission);
    const decided = applyStreamEvent(asked, {
      type: 'tool_permission_decided',
      turnId: 'turn',
      toolUseId: 'tu_1',
      decision: 'deny',
    });
    expect(decided.pendingPermission).toBeNull();
  });

  it('takes the ask from a snapshot of a running turn, and drops it when the turn ends', () => {
    const turn = {
      id: 'turn',
      status: 'running' as const,
      kind: 'reply' as const,
      error: null,
      startedAt: '2026-09-04T00:00:00.000Z',
      finishedAt: null,
      pendingPermission: permission,
    };
    const fromSnapshot = reduce([{ type: 'snapshot', turn, messages: [] }]);
    expect(fromSnapshot.pendingPermission).toEqual(permission);
    expect(initialThreadState([], turn).pendingPermission).toEqual(permission);
    const later = reduce(
      [{ type: 'snapshot', turn: { ...turn, pendingPermission: null }, messages: [] }],
      fromSnapshot
    );
    expect(later.pendingPermission).toBeNull();
    const ended = applyStreamEvent(fromSnapshot, {
      type: 'turn_end',
      turnId: 'turn',
      status: 'canceled',
      error: null,
    });
    expect(ended.pendingPermission).toBeNull();
  });
});

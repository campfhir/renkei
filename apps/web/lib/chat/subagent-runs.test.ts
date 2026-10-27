/**
 * The pure half of a sub-agent's record: a stored transcript read back as
 * chat blocks, and the recorder's stream events. Sealing is stood in for:
 * no content key here, and the envelope is the crypto package's concern.
 */

jest.mock('./content-crypto', () => ({
  ...jest.requireActual<typeof import('./content-crypto')>('./content-crypto'),
  sealText: (text: string) => ({ ok: true, val: text }),
  openText: (stored: string) => stored,
}));

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createSubagentRecorder, parseTranscript } from './subagent-runs';
import { resourceCipher } from './content-crypto';

/** A chat key for the fixtures: the ciphers under test only care that one is there. */
const testCipher = resourceCipher({
  id: '00000000-0000-4000-8000-00000000c1fe',
  key: Buffer.alloc(32, 7),
});

describe('parseTranscript', () => {
  it('reads the messages back as chat blocks and drops what it cannot read', () => {
    const json = JSON.stringify([
      { role: 'user', content: [{ type: 'text', text: 'Find every caller.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'grep first', signature: 's' },
          { type: 'tool_use', id: 'g1', name: 'code_grep', input: { pattern: 'x' } },
          { type: 'bogus' },
        ],
        // How long the model call took (delegate.ts keeps it on the message).
        durationMs: 4200,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'g1', content: 'a.ts:1: x', durationMs: 310 }],
      },
      { role: 'system', content: [] },
      'not a message',
    ]);
    expect(parseTranscript(json)).toEqual([
      { role: 'user', blocks: [{ type: 'text', text: 'Find every caller.' }] },
      {
        role: 'assistant',
        blocks: [
          { type: 'thinking', thinking: 'grep first' },
          { type: 'tool_use', id: 'g1', name: 'code_grep', input: { pattern: 'x' } },
        ],
        durationMs: 4200,
      },
      {
        role: 'user',
        blocks: [{ type: 'tool_result', toolUseId: 'g1', content: 'a.ts:1: x', durationMs: 310 }],
      },
    ]);
    expect(parseTranscript('{')).toEqual([]);
    expect(parseTranscript('{}')).toEqual([]);
  });
});

describe('createSubagentRecorder', () => {
  afterEach(() => resetDataStore());

  it('emits a start, a progress and an end event for the delegating call, and survives a failed write', async () => {
    const events: { startedAt: number; finishedAt: number | null }[] = [];
    const store = createMemoryDataStore();
    const chatId = '00000000-0000-4000-8000-000000000001';
    const turnId = '00000000-0000-4000-8000-000000000002';
    await store.seed({
      chats: [{ id: chatId, owner_subject: 'ann' }],
      chat_turns: [{ id: turnId, chat_id: chatId, status: 'running' }],
    });
    const failing = async () => {
      throw new Error('db down');
    };
    // The run is written for real; its later writes fail, as a dropped connection would.
    registerDataStore({
      ...store,
      chatThreads: {
        ...store.chatThreads,
        progressSubagentRun: failing,
        finishSubagentRun: failing,
      },
    });
    const logged: string[] = [];
    const recorder = createSubagentRecorder(
      { chatId, turnId, cipher: testCipher },
      (event) => events.push(event),
      (message) => logged.push(message)
    );
    const runId = await recorder.start({
      toolUseId: 'd1',
      task: 'do it',
      instructions: null,
      readOnly: false,
      maxSteps: 40,
      model: { provider: 'anthropic', model: 'claude-x', llmModelId: null },
    });
    expect(runId).toEqual(expect.any(String));
    const run = await store.chatThreads.getSubagentRunByCall(chatId, 'd1');
    expect(run).toMatchObject({ id: runId, status: 'running', maxSteps: 40, model: 'claude-x' });
    await recorder.progress(runId ?? '', {
      steps: 2,
      toolCalls: 3,
      lastTool: 'code_read_file',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await recorder.finish(runId ?? '', {
      status: 'completed',
      transcript: [],
      report: 'done',
      error: null,
      steps: 3,
      toolCalls: 4,
    });
    expect(events).toEqual([
      expect.objectContaining({ toolUseId: 'd1', status: 'running', steps: 0, maxSteps: 40 }),
      expect.objectContaining({
        toolUseId: 'd1',
        status: 'running',
        steps: 2,
        toolCalls: 3,
        lastTool: 'code_read_file',
      }),
      expect.objectContaining({
        toolUseId: 'd1',
        status: 'completed',
        steps: 3,
        toolCalls: 4,
        finishedAt: expect.any(Number),
      }),
    ]);
    // Every event carries the one start, so a card can count elapsed time from it.
    const starts = new Set(events.map((event) => event.startedAt));
    expect(starts.size).toBe(1);
    expect(events[0]?.finishedAt).toBeNull();
    expect(events[2]?.finishedAt).toBeGreaterThanOrEqual(events[0]?.startedAt ?? 0);
    // The failed writes were logged, never thrown into the sub-agent's loop.
    expect(logged.length).toBe(2);
  });
});

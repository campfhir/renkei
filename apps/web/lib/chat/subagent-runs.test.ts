/* eslint-disable @typescript-eslint/consistent-type-assertions -- a fake db shaped for exactly the recorder's calls */
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

import { createSubagentRecorder, parseTranscript } from './subagent-runs';

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
  it('emits a start, a progress and an end event for the delegating call, and survives a failed write', async () => {
    const events: unknown[] = [];
    const inserted = jest.fn().mockResolvedValue({ id: 'run-1' });
    const db = {
      insertInto: () => ({
        values: () => ({
          onConflict: () => ({ returning: () => ({ executeTakeFirst: inserted }) }),
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: () => ({
            where: () => ({ execute: jest.fn().mockRejectedValue(new Error('db down')) }),
            execute: jest.fn().mockRejectedValue(new Error('db down')),
          }),
        }),
      }),
    };
    const logged: string[] = [];
    const recorder = createSubagentRecorder(
      // The fake stands in for exactly the calls the recorder makes.
      db as never,
      { tenantId: 't', chatId: 'c', turnId: 'turn' },
      (event) => events.push(event),
      (message) => logged.push(message)
    );
    const runId = await recorder.start({
      toolUseId: 'd1',
      task: 'do it',
      instructions: null,
      readOnly: false,
      maxSteps: 40,
      model: { provider: 'anthropic', model: 'claude-x', llmModelId: 'model-1' },
    });
    expect(runId).toBe('run-1');
    await recorder.progress('run-1', {
      steps: 2,
      toolCalls: 3,
      lastTool: 'code_read_file',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await recorder.finish('run-1', {
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
      expect.objectContaining({ toolUseId: 'd1', status: 'completed', steps: 3, toolCalls: 4 }),
    ]);
    // The failed writes were logged, never thrown into the sub-agent's loop.
    expect(logged.length).toBe(2);
  });
});

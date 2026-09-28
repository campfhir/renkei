/**
 * The pure half of turn recovery: what the turn's rows say the loop was
 * doing when its process went (planResume), and the counters read back
 * off them (resumeSeedOf). The rows are the whole record — no channel,
 * no process state — so this is where the resume's correctness lives.
 */

import type { LlmContentBlock } from '@renkei/agent-llm';
import type { StoredMessage } from './messages';
import { planResume, resumeSeedOf } from './turn-recovery';

let seq = 0;
function row(
  over: Partial<StoredMessage> & { role: StoredMessage['role']; kind: StoredMessage['kind'] }
): StoredMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    chatId: 'c',
    turnId: 't',
    seq,
    status: 'complete',
    blocks: [],
    llmModelId: null,
    provider: null,
    model: null,
    stopReason: null,
    usage: null,
    timing: null,
    error: null,
    summaryId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

const prompt = () =>
  row({ role: 'user', kind: 'prompt', blocks: [{ type: 'text', text: 'do the thing' }] });
const use = (id: string, name: string): LlmContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input: {},
});
const result = (toolUseId: string, isError = false): LlmContentBlock => ({
  type: 'tool_result',
  toolUseId,
  content: 'ok',
  ...(isError ? { isError: true } : {}),
});
const reply = (blocks: LlmContentBlock[], over: Partial<StoredMessage> = {}) =>
  row({
    role: 'assistant',
    kind: 'assistant',
    blocks,
    usage: { inputTokens: 10, outputTokens: 5 },
    ...over,
  });

beforeEach(() => {
  seq = 0;
});

describe('planResume', () => {
  it('drops a half-streamed reply and asks again', () => {
    const streaming = reply([{ type: 'text', text: 'I was say' }], { status: 'streaming' });
    expect(planResume([prompt(), streaming])).toEqual({
      kind: 'restream',
      messageId: streaming.id,
    });
  });

  it('answers the calls of a round that never got its results', () => {
    const rows = [prompt(), reply([use('tu_1', 'code_run'), use('tu_2', 'code_read_file')])];
    expect(planResume(rows)).toEqual({
      kind: 'answer',
      toolUses: [use('tu_1', 'code_run'), use('tu_2', 'code_read_file')],
    });
  });

  it('carries on when the round was answered but the next reply never opened', () => {
    const rows = [
      prompt(),
      reply([use('tu_1', 'code_run')]),
      row({ role: 'user', kind: 'tool_results', blocks: [result('tu_1')] }),
    ];
    expect(planResume(rows)).toEqual({ kind: 'continue' });
  });

  it('finishes a turn whose reply had already ended', () => {
    expect(planResume([prompt(), reply([{ type: 'text', text: 'Done.' }])])).toEqual({
      kind: 'finish',
      status: 'completed',
    });
    expect(
      planResume([prompt(), reply([{ type: 'text', text: 'x' }], { status: 'failed' })])
    ).toEqual({ kind: 'finish', status: 'failed' });
    expect(
      planResume([prompt(), reply([{ type: 'text', text: 'x' }], { status: 'canceled' })])
    ).toEqual({ kind: 'finish', status: 'canceled' });
  });

  it('treats a prelude step in flight like any other unanswered call', () => {
    const rows = [prompt(), reply([use('prelude_abc', 'code_clone')], { stopReason: 'tool_use' })];
    expect(planResume(rows)).toEqual({
      kind: 'answer',
      toolUses: [use('prelude_abc', 'code_clone')],
    });
  });
});

describe('resumeSeedOf', () => {
  it('counts model calls, nudges, tokens, and what auto mode had reached', () => {
    const startedAt = new Date('2026-09-28T10:00:00Z');
    const rows = [
      prompt(),
      // The clone step: the runner's own row, not a model call.
      reply([use('prelude_1', 'code_clone')], { usage: null }),
      row({ role: 'user', kind: 'tool_results', blocks: [result('prelude_1')] }),
      reply([use('tu_1', 'code_delegate')]),
      row({ role: 'user', kind: 'tool_results', blocks: [result('tu_1')] }),
      reply([{ type: 'text', text: 'Looks done.' }]),
      row({ role: 'user', kind: 'nudge', blocks: [{ type: 'text', text: 'carry on' }] }),
      reply([use('tu_2', 'task_complete')]),
      row({ role: 'user', kind: 'tool_results', blocks: [result('tu_2')] }),
      // Streaming when the process went: not a completed call.
      reply([], { status: 'streaming', usage: null }),
    ];
    expect(resumeSeedOf(rows, startedAt)).toEqual({
      startedAt: startedAt.getTime(),
      iterations: 3,
      continues: 1,
      silentRetries: 0,
      spawnedSubagent: true,
      taskDone: true,
      inputTokens: 30,
      outputTokens: 15,
    });
  });

  it('does not count a failed task_complete as done, nor a plain chat as delegating', () => {
    const rows = [
      prompt(),
      reply([use('tu_1', 'jira_get_issue')]),
      row({ role: 'user', kind: 'tool_results', blocks: [result('tu_1')] }),
      reply([use('tu_2', 'task_complete')]),
      row({ role: 'user', kind: 'tool_results', blocks: [result('tu_2', true)] }),
    ];
    expect(resumeSeedOf(rows, new Date(0))).toMatchObject({
      iterations: 2,
      continues: 0,
      spawnedSubagent: false,
      taskDone: false,
    });
  });
});

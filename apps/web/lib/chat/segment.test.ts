import type { ChatBlock, ChatMessageView } from './views';
import { segment, type ToolResult } from './segment';

function assistantMessage(id: string, blocks: ChatBlock[]): ChatMessageView {
  return {
    id,
    turnId: 't1',
    seq: 1,
    role: 'assistant',
    kind: 'assistant',
    status: 'complete',
    blocks,
    llmModelId: null,
    provider: null,
    model: null,
    stopReason: null,
    usage: null,
    error: null,
    createdAt: new Date(0).toISOString(),
    attachments: [],
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): ChatBlock {
  return { type: 'tool_use', id, name, input };
}

function toolResult(toolUseId: string, text: string): ToolResult {
  return { type: 'tool_result', toolUseId, content: text };
}

describe('segment', () => {
  it('gives a code_delegate call one subagent card', () => {
    const messages = [assistantMessage('m1', [toolUse('d1', 'code_delegate', { task: 'go' })])];
    const out = segment(messages, new Map());
    expect(out.filter((part) => part.kind === 'subagent')).toHaveLength(1);
  });

  it('folds a second sighting of the same call id into the first card', () => {
    // The same tool_use id at two positions — the shape a streaming index
    // that does not line up with the final response's would produce: a
    // stale, still-empty copy beside the one the stream finished parsing.
    const messages = [
      assistantMessage('m1', [
        toolUse('d1', 'code_delegate', {}),
        toolUse('d1', 'code_delegate', { task: 'go' }),
      ]),
    ];
    const out = segment(messages, new Map());
    const cards = out.filter((part) => part.kind === 'subagent');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind === 'subagent' && cards[0].step.block.input).toEqual({ task: 'go' });
  });

  it('updates the one card once the report arrives, across two messages', () => {
    const messages = [
      assistantMessage('m1', [toolUse('d1', 'code_delegate', { task: 'go' })]),
      assistantMessage('m2', [toolUse('d1', 'code_delegate', { task: 'go' })]),
    ];
    const results = new Map([['d1', toolResult('d1', 'Sub-agent done.')]]);
    const out = segment(messages, results);
    const cards = out.filter((part) => part.kind === 'subagent');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind === 'subagent' && cards[0].step.result?.content).toBe('Sub-agent done.');
  });

  it('folds a repeated milestone call id the same way', () => {
    const messages = [
      assistantMessage('m1', [
        toolUse('p1', 'code_git_push', {}),
        toolUse('p1', 'code_git_push', { branch: 'main' }),
      ]),
    ];
    const out = segment(messages, new Map());
    expect(out.filter((part) => part.kind === 'milestone')).toHaveLength(1);
  });

  it('gives two genuinely different calls two cards', () => {
    const messages = [
      assistantMessage('m1', [
        toolUse('d1', 'code_delegate', { task: 'first' }),
        toolUse('d2', 'code_delegate', { task: 'second' }),
      ]),
    ];
    const out = segment(messages, new Map());
    expect(out.filter((part) => part.kind === 'subagent')).toHaveLength(2);
  });
});

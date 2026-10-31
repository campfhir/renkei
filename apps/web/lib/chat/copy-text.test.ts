/**
 * A reply's Copy: the prose alone by default; with tool calls, each call's
 * name, input and result between the prose, in order; never the thinking.
 */

import { replyCalls, replyCopyText } from './copy-text';
import type { Segment, ToolResult, WorkStep } from './segment';

const call = (
  id: string,
  name: string,
  input: unknown,
  result: Partial<ToolResult> | null
): Extract<WorkStep, { kind: 'call' }> => ({
  kind: 'call',
  block: { type: 'tool_use', id, name, input },
  result: result ? { type: 'tool_result', toolUseId: id, content: '', ...result } : null,
});

const segments: Segment[] = [
  { kind: 'text', text: '  Looking it up.  ' },
  {
    kind: 'work',
    modelMs: 0,
    steps: [
      { kind: 'thinking', text: 'secret scratch work' },
      call('a', 'jira_search', { jql: 'project = OPS' }, { content: 'OPS-1 Fix login' }),
    ],
  },
  {
    kind: 'subagent',
    step: call('b', 'chat_delegate', { task: 'x' }, { content: 'nope', isError: true }),
  },
  { kind: 'text', text: 'Found OPS-1.' },
];

describe('replyCopyText', () => {
  it('copies the prose alone by default', () => {
    expect(replyCopyText(segments)).toBe('Looking it up.\n\nFound OPS-1.');
  });

  it('copies each call between the prose with tool calls on, but no thinking', () => {
    const text = replyCopyText(segments, { toolCalls: true });
    expect(text).toBe(
      [
        'Looking it up.',
        'Tool call: jira_search\n```json\n{\n  "jql": "project = OPS"\n}\n```\nResult:\n```\nOPS-1 Fix login\n```',
        'Tool call: chat_delegate\n```json\n{\n  "task": "x"\n}\n```\nError:\n```\nnope\n```',
        'Found OPS-1.',
      ].join('\n\n')
    );
    expect(text).not.toContain('secret scratch work');
  });

  it('fences a result that holds a fence of its own so it cannot close early', () => {
    const text = replyCopyText(
      [
        {
          kind: 'work',
          modelMs: 0,
          steps: [call('c', 'code_read', {}, { content: '```ts\nx\n```' })],
        },
      ],
      { toolCalls: true }
    );
    expect(text).toContain('````\n```ts\nx\n```\n````');
  });

  it('says so when a call never got its result', () => {
    const text = replyCopyText(
      [{ kind: 'work', modelMs: 0, steps: [call('d', 'slow', null, null)] }],
      { toolCalls: true }
    );
    expect(text).toBe('Tool call: slow\n```json\n{}\n```\nNo result.');
  });
});

describe('replyCalls', () => {
  it('lists the calls folded and carded alike, in order', () => {
    expect(replyCalls(segments).map((step) => step.block.id)).toEqual(['a', 'b']);
  });
});

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

  it('gives an ordinary chat’s chat_delegate call the same subagent card', () => {
    const messages = [
      assistantMessage('m1', [toolUse('d1', 'chat_delegate', { task: 'read the tickets' })]),
    ];
    const out = segment(messages, new Map());
    expect(out.filter((part) => part.kind === 'subagent')).toHaveLength(1);
    expect(out.filter((part) => part.kind === 'work')).toHaveLength(0);
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
    const out = segment(messages, new Map(), { codeProject: true });
    expect(out.filter((part) => part.kind === 'milestone')).toHaveLength(1);
  });

  it('lifts a host act on a pull request, a commit or a branch as a milestone in a code chat', () => {
    const messages = [
      assistantMessage('m1', [
        toolUse('b1', 'bitbucket_create_branch', { name: 'feat/x' }),
        toolUse('c1', 'github_commit_files', { branch: 'feat/x' }),
        toolUse('p1', 'github_create_pull_request', { title: 'Fix' }),
      ]),
    ];
    const out = segment(messages, new Map(), { codeProject: true });
    expect(out.filter((part) => part.kind === 'milestone')).toHaveLength(3);
    expect(out.filter((part) => part.kind === 'work')).toHaveLength(0);
  });

  it('outside a code project, a word to the host folds like any other call', () => {
    const messages = [
      assistantMessage('m1', [
        toolUse('p1', 'github_create_pull_request', { title: 'Fix' }),
        toolUse('c1', 'bitbucket_commit_files', { branch: 'feat/x' }),
        toolUse('r1', 'jira_get_issue', { key: 'OPS-1' }),
      ]),
    ];
    const out = segment(messages, new Map());
    expect(out.filter((part) => part.kind === 'milestone')).toHaveLength(0);
    const work = out.filter((part) => part.kind === 'work');
    expect(work).toHaveLength(1);
    expect(work[0]?.kind === 'work' && work[0].steps).toHaveLength(3);
  });

  it('folds the host’s reads and quieter acts with the rest of the work, in a code chat too', () => {
    const messages = [
      assistantMessage('m1', [
        toolUse('r1', 'bitbucket_read_file', { path: 'a.ts' }),
        toolUse('r2', 'github_list_branches', {}),
        toolUse('r3', 'bitbucket_list_pipelines', {}),
        toolUse('r4', 'github_add_pr_comment', { body: 'ok' }),
        toolUse('r5', 'jira_get_issue', { key: 'OPS-1' }),
      ]),
    ];
    const out = segment(messages, new Map(), { codeProject: true });
    expect(out.filter((part) => part.kind === 'milestone')).toHaveLength(0);
    const work = out.filter((part) => part.kind === 'work');
    expect(work).toHaveLength(1);
    expect(work[0]?.kind === 'work' && work[0].steps).toHaveLength(5);
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

  describe('mockups', () => {
    const input = { title: 'Login', format: 'html', source: '<p>hi</p>' };

    it('lifts a finished chat_show_mockup call out of the fold as a card', () => {
      const messages = [assistantMessage('m1', [toolUse('k1', 'chat_show_mockup', input)])];
      const out = segment(messages, new Map([['k1', toolResult('k1', 'Showed it.')]]));
      const cards = out.filter((part) => part.kind === 'mockup');
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ request: { title: 'Login', format: 'html', width: 1024 } });
      expect(out.filter((part) => part.kind === 'work')).toHaveLength(0);
    });

    it('leaves a call still pending in the fold', () => {
      const messages = [assistantMessage('m1', [toolUse('k1', 'chat_show_mockup', input)])];
      const out = segment(messages, new Map());
      expect(out.filter((part) => part.kind === 'mockup')).toHaveLength(0);
      expect(out.filter((part) => part.kind === 'work')).toHaveLength(1);
    });

    it('folds a call the tool refused, so no card claims a broken mockup', () => {
      const messages = [assistantMessage('m1', [toolUse('k1', 'chat_show_mockup', input)])];
      const results = new Map([['k1', { ...toolResult('k1', 'did not compile'), isError: true }]]);
      const out = segment(messages, results);
      expect(out.filter((part) => part.kind === 'mockup')).toHaveLength(0);
    });

    it('updates the one card when the same call is seen twice', () => {
      const messages = [
        assistantMessage('m1', [toolUse('k1', 'chat_show_mockup', input)]),
        assistantMessage('m2', [toolUse('k1', 'chat_show_mockup', input)]),
      ];
      const out = segment(messages, new Map([['k1', toolResult('k1', 'ok')]]));
      expect(out.filter((part) => part.kind === 'mockup')).toHaveLength(1);
    });
  });
});

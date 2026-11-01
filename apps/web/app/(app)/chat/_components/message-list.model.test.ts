/**
 * How a chat thread reads (message-list.model.ts): which rows make a
 * turn, what each tool call says in which state, what a run of work folds
 * into, what the sub-agent, milestone and permission cards show, and what
 * a reply's Copy offers. The thread's specs (chat-copy, host-tool-cards,
 * chat-subagent, code-subagent, chat-title, chat-permission) used to press
 * through these in a browser; what Copy puts on the clipboard is
 * lib/chat/copy-text.test.ts's, and what segment() lifts out of a fold is
 * lib/chat/segment.test.ts's.
 */

import type { SubagentProgress } from '@/lib/chat/stream-events';
import { segment, type Segment, type ToolResult } from '@/lib/chat/segment';
import type { AttachmentView, ChatBlock, ChatMessageView, TurnView } from '@/lib/chat/views';
import {
  askedCall,
  callLine,
  cardState,
  compactionView,
  copyMenu,
  copyReducer,
  foldCallState,
  groupTurns,
  initialCopyState,
  initialPermissionCardState,
  inlineArtifacts,
  isAtBottom,
  listenState,
  milestoneCardView,
  openCallsOfLatestRow,
  permissionButtons,
  permissionCardReducer,
  permissionCardText,
  replyCopies,
  replyEndNote,
  resultRowsById,
  resultsById,
  showsReplyActions,
  subagentCardView,
  toolIconFor,
  toolLabel,
  turnErrorLine,
  workFoldView,
  type Call,
  type CopyState,
  type PermissionCardState,
} from './message-list.model';

function row(
  id: string,
  kind: ChatMessageView['kind'],
  blocks: ChatBlock[],
  extra: Partial<ChatMessageView> = {}
): ChatMessageView {
  return {
    id,
    turnId: 't1',
    seq: 1,
    role: kind === 'prompt' ? 'user' : kind === 'tool_results' ? 'user' : 'assistant',
    kind,
    status: 'complete',
    blocks,
    llmModelId: null,
    provider: null,
    model: null,
    stopReason: null,
    usage: null,
    error: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    attachments: [],
    ...extra,
  };
}

const text = (value: string): ChatBlock => ({ type: 'text', text: value });
const use = (id: string, name: string, input: unknown = {}): ChatBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const answer = (
  toolUseId: string,
  content: string,
  extra: Partial<ToolResult> = {}
): ToolResult => ({
  type: 'tool_result',
  toolUseId,
  content,
  ...extra,
});

function call(
  id: string,
  name: string,
  input: unknown = {},
  result: Partial<ToolResult> | null = null
): Call {
  return {
    kind: 'call',
    block: { type: 'tool_use', id, name, input },
    result: result ? answer(id, '', result) : null,
  };
}

const quiet = { waitingOn: null, pendingToolCalls: [], live: false };

const TURN: TurnView = {
  id: 't1',
  status: 'running',
  kind: 'reply',
  error: null,
  startedAt: '2026-11-01T00:00:00.000Z',
  finishedAt: null,
};

describe('the thread', () => {
  it('puts a turn’s prompt and its reply rows together, and the next turn apart', () => {
    const turns = groupTurns([
      row('p1', 'prompt', [text('Hi')]),
      row('a1', 'assistant', [text('Hello')]),
      row('p2', 'prompt', [text('Again')], { turnId: 't2' }),
      row('a2', 'assistant', [use('c1', 'jira_search')], { turnId: 't2' }),
      row('r2', 'tool_results', [answer('c1', 'none')], { turnId: 't2' }),
      row('a3', 'assistant', [text('Nothing found.')], { turnId: 't2' }),
    ]);
    expect(turns.map((turn) => turn.key)).toEqual(['t1', 't2']);
    expect(turns[1].prompts.map((message) => message.id)).toEqual(['p2']);
    expect(turns[1].replies.map((message) => message.id)).toEqual(['a2', 'r2', 'a3']);
  });

  it('keeps a row with no turn as a turn of its own', () => {
    const turns = groupTurns([
      row('p1', 'prompt', [text('Hi')], { turnId: null }),
      row('a1', 'assistant', [text('Hello')], { turnId: null }),
    ]);
    expect(turns.map((turn) => turn.key)).toEqual(['p1', 'a1']);
  });

  it('finds each call’s result, and the row that carried it, by the call’s id', () => {
    const messages = [
      row('a1', 'assistant', [use('c1', 'jira_search')]),
      row('r1', 'tool_results', [answer('c1', 'OPS-1')]),
    ];
    expect(resultsById(messages).get('c1')?.content).toBe('OPS-1');
    expect(resultRowsById(messages).get('c1')).toBe('r1');
  });

  it('follows the stream while the reader is within a thumb of the bottom, and stops past that', () => {
    expect(isAtBottom({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 480 })).toBe(true);
    expect(isAtBottom({ scrollHeight: 2000, scrollTop: 1452, clientHeight: 500 })).toBe(false);
    expect(isAtBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });

  it('says why a turn ended badly under the thread, and nothing while it runs or once it completes', () => {
    const turn = (status: TurnView['status'], error: string | null) => ({ ...TURN, status, error });
    expect(turnErrorLine(null)).toBeNull();
    expect(turnErrorLine(turn('running', 'x'))).toBeNull();
    expect(turnErrorLine(turn('completed', 'x'))).toBeNull();
    expect(turnErrorLine(turn('failed', 'The model is unavailable.'))).toBe(
      'The model is unavailable.'
    );
    expect(turnErrorLine(turn('failed', null))).toBeNull();
  });

  it('counts compaction as it goes, and says what it did once it is done', () => {
    expect(
      compactionView({ status: 'running', foldedSoFar: 3, totalToFold: 12, turnId: 't1' })
    ).toEqual({ label: 'Compacting the conversation… 3 of 12', percent: 25 });
    expect(
      compactionView({ status: 'running', foldedSoFar: 0, totalToFold: 0, turnId: 't1' })
    ).toEqual({
      label: 'Compacting the conversation…',
      percent: null,
    });
    expect(
      compactionView({ status: 'done', foldedSoFar: 1, totalToFold: 1, turnId: 't1' }).label
    ).toBe('Compacted 1 earlier message into a summary.');
    expect(
      compactionView({ status: 'done', foldedSoFar: 0, totalToFold: 0, turnId: 't1' }).label
    ).toBe('Nothing to compact — the conversation is already tight.');
    expect(
      compactionView({ status: 'failed', foldedSoFar: 0, totalToFold: 4, turnId: 't1' }).label
    ).toBe('Compaction failed.');
  });
});

describe('a tool call’s state', () => {
  it('reads as done or failed by its result, whatever else is going on', () => {
    const live = { waitingOn: 'c1', pendingToolCalls: ['c1'], live: true };
    expect(foldCallState(call('c1', 'x', {}, { content: 'ok' }), live)).toBe('done');
    expect(foldCallState(call('c1', 'x', {}, { content: 'no', isError: true }), live)).toBe(
      'failed'
    );
  });

  it('waits on the person while the turn is parked behind it, before it counts as running', () => {
    expect(
      foldCallState(call('c1', 'x'), { waitingOn: 'c1', pendingToolCalls: ['c1'], live: true })
    ).toBe('waiting');
  });

  it('runs at the live end of the reply, or while the stream says so', () => {
    expect(foldCallState(call('c1', 'x'), { ...quiet, live: true })).toBe('pending');
    expect(foldCallState(call('c1', 'x'), { ...quiet, pendingToolCalls: ['c1'] })).toBe('pending');
  });

  it('in a fold, an unanswered call the run moved past reads as called', () => {
    expect(foldCallState(call('c1', 'x'), quiet)).toBe('done');
  });

  it('on a card, an unanswered call nobody is running failed', () => {
    const context = { ...quiet, streaming: false, inFlight: new Set<string>() };
    expect(cardState(call('c1', 'chat_delegate'), context)).toBe('failed');
  });

  it('keeps an earlier sub-agent card working while the turn streams, though a snapshot dropped it from the stream’s list', () => {
    const messages = [
      row('a1', 'assistant', [use('d1', 'chat_delegate'), use('d2', 'chat_delegate')]),
    ];
    const inFlight = openCallsOfLatestRow(messages, new Map());
    expect([...inFlight]).toEqual(['d1', 'd2']);
    expect(cardState(call('d1', 'chat_delegate'), { ...quiet, streaming: true, inFlight })).toBe(
      'pending'
    );
    // Once the turn stops streaming, the same unanswered call failed.
    expect(cardState(call('d1', 'chat_delegate'), { ...quiet, streaming: false, inFlight })).toBe(
      'failed'
    );
  });

  it('counts only the latest tool-calling row’s unanswered calls as open', () => {
    const messages = [
      row('a1', 'assistant', [use('c1', 'x'), use('c2', 'x')]),
      row('r1', 'tool_results', [answer('c1', 'ok')]),
      row('a2', 'assistant', [use('c3', 'x'), use('c4', 'x')]),
      row('r2', 'tool_results', [answer('c3', 'ok')]),
    ];
    expect([...openCallsOfLatestRow(messages, resultsById(messages))]).toEqual(['c4']);
  });

  it('finds the call a permission ask is about, for the card to show what it will send', () => {
    const messages = [row('a1', 'assistant', [use('c1', 'chat_memory_remember', { note: 'n' })])];
    expect(askedCall(messages, 'c1')).toMatchObject({ name: 'chat_memory_remember' });
    expect(askedCall(messages, 'nope')).toBeNull();
  });
});

describe('a tool call’s line', () => {
  it('says calling, called, failed or waiting before the tool’s name', () => {
    const label = toolLabel('jira_search_issues');
    expect(callLine('jira_search_issues', 'pending')).toEqual({
      kind: 'verb',
      verb: 'Calling ',
      label,
    });
    expect(callLine('jira_search_issues', 'done')).toMatchObject({ verb: 'Called ' });
    expect(callLine('jira_search_issues', 'failed')).toMatchObject({ verb: 'Failed: ' });
    expect(callLine('jira_search_issues', 'waiting')).toMatchObject({
      verb: 'Waiting for permission to call ',
    });
  });

  it('reads a code step that has its own sentence as that sentence, except while it waits', () => {
    expect(callLine('code_clone', 'pending')).toEqual({
      kind: 'sentence',
      text: 'Cloning the repository',
    });
    expect(callLine('code_clone', 'done')).toEqual({
      kind: 'sentence',
      text: 'Cloned the repository',
    });
    expect(callLine('code_clone', 'failed')).toEqual({
      kind: 'sentence',
      text: 'The clone failed',
    });
    expect(callLine('code_clone', 'waiting')).toEqual({
      kind: 'verb',
      verb: 'Waiting for permission to call ',
      label: 'Clone repository',
    });
  });

  it('names a code tool by its own label', () => {
    expect(toolLabel('code_grep')).toBe('Search code');
  });

  it('marks memory, recall, renames, git, sub-agents and images with their own icons', () => {
    expect(toolIconFor('chat_memory_remember')).toBe('memory');
    expect(toolIconFor('project_memory_forget')).toBe('memory');
    expect(toolIconFor('chat_recall_chats')).toBe('history');
    expect(toolIconFor('chat_rename')).toBe('pencil');
    expect(toolIconFor('chat_compact')).toBe('package');
    expect(toolIconFor('task_complete')).toBe('check');
    expect(toolIconFor('code_git_commit')).toBe('gitCommit');
    expect(toolIconFor('code_clone')).toBe('gitClone');
    expect(toolIconFor('code_edit_file')).toBe('diff');
    expect(toolIconFor('code_run')).toBe('terminal');
    expect(toolIconFor('chat_delegate')).toBe('group');
    expect(toolIconFor('code_grep')).toBe('file');
    expect(toolIconFor('jira_search_issues')).toBe('tool');
  });
});

describe('a run of work, folded', () => {
  it('reads as the thought and how many calls, once it is over', () => {
    const view = workFoldView(
      [
        { kind: 'thinking', text: 'Which issues?' },
        call('c1', 'github_list_branches', {}, { content: 'main' }),
        call('c2', 'github_read_file', {}, { content: 'x' }),
        call('c3', 'github_create_pull_request', {}, { content: '#12' }),
      ],
      { ...quiet, modelMs: 0 }
    );
    expect(view.label).toEqual({ kind: 'summary', text: 'Thought · 3 tool calls' });
    expect(view.callCount).toBe(3);
    expect(view.icon).toBe('tool');
    expect(view.foldable).toBe(true);
  });

  it('says where the time went: the model’s calls apart from the tools', () => {
    const view = workFoldView([call('c1', 'x', {}, { content: 'ok', durationMs: 1000 })], {
      ...quiet,
      modelMs: 2000,
    });
    expect(view.label).toEqual({ kind: 'summary', text: '1 tool call · 2s model, 1s tools' });
  });

  it('says what is happening right now while the run is live', () => {
    const context = { ...quiet, live: true, modelMs: 0 };
    expect(workFoldView([call('c1', 'chat_rename')], context).label).toEqual({
      kind: 'pending',
      name: 'chat_rename',
      line: callLine('chat_rename', 'pending'),
    });
    expect(
      workFoldView([call('c1', 'chat_memory_remember')], { ...context, waitingOn: 'c1' }).label
    ).toMatchObject({ kind: 'waiting', name: 'chat_memory_remember' });
    expect(workFoldView([{ kind: 'thinking', text: 'Hmm' }], context).label).toEqual({
      kind: 'thinking',
    });
  });

  it('is a plain line, not an empty fold, when the thinking has no text', () => {
    const view = workFoldView([{ kind: 'thinking', text: '  ' }], { ...quiet, modelMs: 0 });
    expect(view.foldable).toBe(false);
    expect(view.icon).toBe('brain');
    expect(view.label).toEqual({ kind: 'summary', text: 'Thought' });
  });

  it('reads as an error only when the latest answered call failed', () => {
    const steps = [
      call('c1', 'x', {}, { content: 'no', isError: true }),
      call('c2', 'x', {}, { content: 'ok' }),
    ];
    expect(workFoldView(steps, { ...quiet, modelMs: 0 }).failed).toBe(false);
    expect(workFoldView([...steps].reverse(), { ...quiet, modelMs: 0 }).failed).toBe(true);
  });

  it('in a plain chat, a pull request folds with the host reads; in a code chat it stands alone', () => {
    const messages = [
      row('a1', 'assistant', [use('c1', 'github_list_branches'), use('c2', 'github_read_file')]),
      row('r1', 'tool_results', [answer('c1', 'main'), answer('c2', 'not found')]),
      row('a2', 'assistant', [use('c3', 'github_create_pull_request')]),
      row('r2', 'tool_results', [
        answer(
          'c3',
          'Created pull request #12: Fix the timeout\n[Open on GitHub](https://github.com/acme/demo/pull/12)'
        ),
      ]),
      row('a3', 'assistant', [text('Pull request #12 is open against main.')]),
    ];
    const results = resultsById(messages);
    const kinds = (parts: Segment[]) => parts.map((part) => part.kind);
    const plain = segment(messages, results);
    expect(kinds(plain)).toEqual(['work', 'text']);
    const fold = plain[0];
    expect(
      fold.kind === 'work' && workFoldView(fold.steps, { ...quiet, modelMs: 0 }).label
    ).toEqual({
      kind: 'summary',
      text: '3 tool calls',
    });
    const code = segment(messages, results, { codeProject: true });
    expect(kinds(code)).toEqual(['work', 'milestone', 'text']);
    const card = code[1];
    if (card.kind !== 'milestone') throw new Error('expected a milestone');
    const view = milestoneCardView(card.step, 'done', true);
    expect(view.sentence).toBe('Opened a pull request');
    expect(view.headline).toBe('Created pull request #12: Fix the timeout');
    expect(view.link).toEqual({
      label: 'Open on GitHub',
      url: 'https://github.com/acme/demo/pull/12',
    });
  });
});

describe('a rename the person asked for', () => {
  it('reads as an ordinary call in the reply’s fold, with its pencil', () => {
    const messages = [
      row('p1', 'prompt', [text('Call this chat something about the budget review.')]),
      row('a1', 'assistant', [use('c1', 'chat_rename', { title: 'Budget review' })]),
      row('r1', 'tool_results', [answer('c1', 'Renamed the chat to “Budget review”.')]),
      row('a2', 'assistant', [text('Done — this chat is now called Budget review.')]),
    ];
    const [turn] = groupTurns(messages);
    const parts = segment(turn.replies, resultsById(messages));
    expect(parts.map((part) => part.kind)).toEqual(['work', 'text']);
    const fold = parts[0];
    if (fold.kind !== 'work') throw new Error('expected a fold');
    expect(workFoldView(fold.steps, { ...quiet, modelMs: 0 }).label).toEqual({
      kind: 'summary',
      text: '1 tool call',
    });
    expect(toolIconFor('chat_rename')).toBe('pencil');
    expect(callLine('chat_rename', 'done')).toEqual({
      kind: 'verb',
      verb: 'Called ',
      label: toolLabel('chat_rename'),
    });
  });
});

describe('a reply’s ending and its actions', () => {
  it('says a failed reply’s error, and Stopped or Interrupted when it was cut short', () => {
    expect(replyEndNote(row('a', 'assistant', [], { status: 'failed', error: 'Boom' }))).toEqual({
      tone: 'error',
      text: 'Boom',
    });
    expect(replyEndNote(row('a', 'assistant', [], { status: 'failed' }))).toBeNull();
    expect(replyEndNote(row('a', 'assistant', [], { status: 'canceled' }))).toEqual({
      tone: 'quiet',
      text: 'Stopped.',
    });
    expect(replyEndNote(row('a', 'assistant', [], { status: 'interrupted' }))).toEqual({
      tone: 'quiet',
      text: 'Interrupted.',
    });
    expect(replyEndNote(row('a', 'assistant', []))).toBeNull();
  });

  it('shows Copy and Listen once there is prose and the reply has finished', () => {
    expect(showsReplyActions('Done.', false)).toBe(true);
    expect(showsReplyActions('Done.', true)).toBe(false);
    expect(showsReplyActions('', false)).toBe(false);
  });

  it('plays, pauses or offers Listen per reply', () => {
    expect(listenState(null, false, 't1')).toBe('idle');
    expect(listenState('t2', false, 't1')).toBe('idle');
    expect(listenState('t1', false, 't1')).toBe('playing');
    expect(listenState('t1', true, 't1')).toBe('paused');
  });

  it('shows the files the reply’s calls kept, but not a picture its image card already drew', () => {
    const file = (id: string, messageId: string | null): AttachmentView => ({
      id,
      filename: `${id}.png`,
      contentType: 'image/png',
      sizeBytes: 1,
      extractStatus: 'done',
      messageId,
    });
    const messages = [
      row('a1', 'assistant', [use('i1', 'chat_generate_image'), use('c1', 'x')]),
      row('r1', 'tool_results', [answer('i1', 'ok'), answer('c1', 'ok')]),
    ];
    const artifacts = [file('pic', 'r1'), file('other', 'elsewhere')];
    const rows = resultRowsById(messages);
    // No image card: the file shows under the reply.
    expect(inlineArtifacts(messages, [], artifacts, rows).map((a) => a.id)).toEqual(['pic']);
    // The image card drew it: not twice.
    const image: Segment = {
      kind: 'image',
      step: call('i1', 'chat_generate_image', {}, { content: 'ok' }),
    };
    expect(inlineArtifacts(messages, [image], artifacts, rows)).toEqual([]);
  });
});

describe('Copy', () => {
  const prompt = row('p1', 'prompt', [text('Rename this chat, then tell me.')]);
  const withCall: Segment[] = [
    {
      kind: 'work',
      modelMs: 0,
      steps: [call('c1', 'chat_rename', { title: 'X' }, { content: 'Renamed the chat to X.' })],
    },
    { kind: 'text', text: 'Renamed it to X.' },
  ];

  it('copies the prose, and offers the tool calls and the context behind the chevron', () => {
    const { text: plain, more } = replyCopies(withCall, [prompt]);
    expect(plain).toBe('Renamed it to X.');
    expect(more.map((choice) => choice.label)).toEqual([
      'Copy with tool calls',
      'Copy with context',
    ]);
    expect(more[0].text).toContain('Tool call: chat_rename');
    expect(more[1].text).toMatch(/^Prompt:\nRename this chat, then tell me\.\n\nReply:\nTool call/);
  });

  it('offers no tool calls on a reply that made none, only the context', () => {
    const { more } = replyCopies([{ kind: 'text', text: 'Hi.' }], [prompt]);
    expect(more.map((choice) => choice.label)).toEqual(['Copy with context']);
    expect(more[0].text).toBe('Prompt:\nRename this chat, then tell me.\n\nReply:\nHi.');
  });

  it('offers no context when the prompt has no text of its own', () => {
    const bare = row('p1', 'prompt', [text('<attachment name="a.txt">x</attachment>')]);
    expect(replyCopies(withCall, [bare]).more.map((choice) => choice.label)).toEqual([
      'Copy with tool calls',
    ]);
  });

  it('lists the plain copy first in the menu, and has no menu with nothing more to offer', () => {
    const { text: plain, more } = replyCopies(withCall, [prompt]);
    expect(copyMenu(plain, more).map((choice) => choice.label)).toEqual([
      'Copy text only',
      'Copy with tool calls',
      'Copy with context',
    ]);
    expect(copyMenu(plain, more)[0].text).toBe(plain);
    expect(copyMenu('Hi.', [])).toEqual([]);
  });

  it('opens and shuts the menu, shuts it on a pick, and shows Copied until it expires', () => {
    const fold = (
      actions: Parameters<typeof copyReducer>[1][],
      from: CopyState = initialCopyState
    ) => actions.reduce(copyReducer, from);
    expect(fold([{ type: 'toggle-menu' }])).toEqual({ copied: false, menuOpen: true });
    expect(fold([{ type: 'toggle-menu' }, { type: 'toggle-menu' }]).menuOpen).toBe(false);
    expect(fold([{ type: 'toggle-menu' }, { type: 'close-menu' }]).menuOpen).toBe(false);
    expect(fold([{ type: 'toggle-menu' }, { type: 'picked' }, { type: 'copied' }])).toEqual({
      copied: true,
      menuOpen: false,
    });
    expect(fold([{ type: 'copied' }, { type: 'copied-expired' }]).copied).toBe(false);
  });
});

describe('the sub-agent card', () => {
  const delegate = (input: Record<string, unknown>, result: Partial<ToolResult> | null = null) =>
    call('d1', 'chat_delegate', input, result);

  it('a plain chat’s sub-agent is read-only, names its model, and leads with its report once back', () => {
    const view = subagentCardView(
      delegate(
        { task: 'Read the sprint.\nEvery issue.', model: ' Reading model ' },
        { content: '\nTwo issues: OPS-41 and OPS-44.\nMore.' }
      ),
      'done',
      null,
      null
    );
    expect(view).toMatchObject({
      sentence: 'Sub-agent reported',
      readOnly: true,
      model: 'Reading model',
      inline: 'Two issues: OPS-41 and OPS-44.',
      transcriptLabel: 'View transcript',
      running: false,
    });
  });

  it('a code chat’s sub-agent is read-only only when its task says so', () => {
    const code = (readOnly: boolean) =>
      subagentCardView(
        call('d1', 'code_delegate', { task: 'Go', readOnly }),
        'pending',
        null,
        null
      );
    expect(code(true)).toMatchObject({ readOnly: true, sentence: 'Sub-agent investigating' });
    expect(code(false)).toMatchObject({ readOnly: false, sentence: 'Sub-agent working' });
  });

  it('shows its task’s first line while it starts, and Follow the sub-agent while it runs', () => {
    const view = subagentCardView(
      delegate({ task: '\nRead the sprint.\nAll of it.' }),
      'pending',
      null,
      null
    );
    expect(view.inline).toBe('Read the sprint.');
    expect(view.transcriptLabel).toBe('Follow the sub-agent');
  });

  it('counts its calls and its time while the stream says it works', () => {
    const progress: SubagentProgress = {
      toolUseId: 'd1',
      status: 'running',
      steps: 2,
      maxSteps: 8,
      toolCalls: 1,
      lastTool: 'jira_search_issues',
      startedAt: 0,
      finishedAt: null,
    };
    const view = subagentCardView(delegate({ task: 'Go' }), 'pending', progress, '4s');
    expect(view.inline).toBe('2/8 calls · 1 tool call · 4s');
    expect(view.liveCounts).toBe('2 of 8 model calls · 1 tool call');
    expect(view.lastTool).toMatch(/^Calling /);
  });

  it('drops the live counts once the run is over', () => {
    const progress: SubagentProgress = {
      toolUseId: 'd1',
      status: 'completed',
      steps: 2,
      maxSteps: 8,
      toolCalls: 1,
      lastTool: null,
      startedAt: 0,
      finishedAt: 4000,
    };
    const view = subagentCardView(
      delegate({ task: 'Go' }, { content: 'Done.' }),
      'done',
      progress,
      '4s'
    );
    expect(view.live).toBeNull();
    expect(view.liveCounts).toBeNull();
    expect(view.inline).toBe('Done.');
  });

  it('says it is waiting for permission, or that it failed', () => {
    expect(subagentCardView(delegate({}), 'waiting', null, null).sentence).toBe(
      'Waiting for permission to start a sub-agent'
    );
    expect(
      subagentCardView(delegate({}, { content: 'x', isError: true }), 'failed', null, null).sentence
    ).toBe('The sub-agent failed');
  });
});

describe('the milestone card', () => {
  it('a commit shows its sha and subject, and View diff where the chat can open it, once done', () => {
    const step = call(
      'c1',
      'code_git_commit',
      {},
      { content: 'Committed on fix/x: 1a2b3c4 Fix the timeout' }
    );
    const view = milestoneCardView(step, 'done', true);
    expect(view.commit).toEqual({ sha: '1a2b3c4', branch: 'fix/x', subject: 'Fix the timeout' });
    expect(view.headline).toBe('1a2b3c4 Fix the timeout');
    expect(view.canShowCommit).toBe(true);
    expect(milestoneCardView(step, 'done', false).canShowCommit).toBe(false);
    expect(view.tone).toBe('done');
  });

  it('a failed call shows its first line, red', () => {
    const view = milestoneCardView(
      call(
        'c1',
        'code_git_push',
        {},
        { content: '\nrejected: non-fast-forward\nmore', isError: true }
      ),
      'failed',
      true
    );
    expect(view.failLine).toBe('rejected: non-fast-forward');
    expect(view.inline).toBe('rejected: non-fast-forward');
    expect(view.tone).toBe('failed');
    expect(view.link).toBeNull();
  });

  it('auto mode’s task_complete reads as the end of the task, or as needing the person', () => {
    const done = call(
      't1',
      'task_complete',
      { summary: 'Shipped it.', outcome: 'done' },
      { content: 'ok' }
    );
    expect(milestoneCardView(done, 'done', false)).toMatchObject({
      sentence: 'Task complete',
      headline: 'Shipped it.',
      tone: 'complete',
    });
    const ask = call(
      't1',
      'task_complete',
      { summary: 'Which branch?', outcome: 'needs_input' },
      { content: 'ok' }
    );
    expect(milestoneCardView(ask, 'done', false)).toMatchObject({
      sentence: 'Needs your input',
      tone: 'needs-input',
    });
    expect(milestoneCardView(call('t1', 'task_complete'), 'pending', false)).toMatchObject({
      sentence: 'Marking the task complete',
      tone: 'busy',
    });
  });

  it('keeps the host’s link off until the call is done', () => {
    const step = call(
      'c1',
      'github_create_pull_request',
      {},
      {
        content: 'Created pull request #12\n[Open on GitHub](https://github.com/acme/demo/pull/12)',
      }
    );
    expect(milestoneCardView(step, 'done', false).link).not.toBeNull();
    expect(milestoneCardView(step, 'pending', false).link).toBeNull();
  });
});

describe('the permission card', () => {
  const fold = (
    actions: Parameters<typeof permissionCardReducer>[1][],
    from: PermissionCardState = initialPermissionCardState
  ) => actions.reduce(permissionCardReducer, from);

  it('asks the owner, with the three answers on', () => {
    expect(permissionCardText('chat_memory_remember', true, null).lead).toBe('Allow this?');
    expect(permissionButtons(initialPermissionCardState)).toEqual([
      { decision: 'once', label: 'Allow once', disabled: false },
      { decision: 'always', label: 'Always allow', disabled: false },
      { decision: 'deny', label: 'Deny', disabled: false },
    ]);
  });

  it('tells anyone else the owner decides', () => {
    expect(permissionCardText('chat_memory_remember', false, null).lead).toBe(
      'Waiting for the owner'
    );
  });

  it('shows what the call will send, when the call is in view', () => {
    const block = {
      type: 'tool_use' as const,
      id: 'c1',
      name: 'chat_memory_remember',
      input: { note: 'OPS-41 carries over' },
    };
    expect(permissionCardText('chat_memory_remember', true, block).input).toBe(
      '{\n  "note": "OPS-41 carries over"\n}'
    );
    expect(permissionCardText('chat_memory_remember', true, null).input).toBeNull();
  });

  it('turns every button off while an answer is on its way, the pressed one saying so', () => {
    const state = fold([{ type: 'decide', decision: 'always' }]);
    expect(permissionButtons(state)).toEqual([
      { decision: 'once', label: 'Allow once', disabled: true },
      { decision: 'always', label: 'Allowing…', disabled: true },
      { decision: 'deny', label: 'Deny', disabled: true },
    ]);
    expect(permissionButtons(fold([{ type: 'decide', decision: 'deny' }]))[2].label).toBe(
      'Denying…'
    );
  });

  it('ignores a second press while the first is on its way', () => {
    expect(
      fold([
        { type: 'decide', decision: 'once' },
        { type: 'decide', decision: 'deny' },
      ]).busy
    ).toBe('once');
  });

  it('a refused answer puts the buttons back and says why; the next press clears it', () => {
    const refused = fold([
      { type: 'decide', decision: 'once' },
      { type: 'refused', error: 'The turn is no longer waiting on this.' },
    ]);
    expect(refused).toEqual({ busy: null, error: 'The turn is no longer waiting on this.' });
    expect(permissionButtons(refused).every((button) => !button.disabled)).toBe(true);
    expect(fold([{ type: 'decide', decision: 'deny' }], refused)).toEqual({
      busy: 'deny',
      error: null,
    });
  });
});

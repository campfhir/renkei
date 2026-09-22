import type { ChatMessageView } from '@/lib/chat/views';
import { commitsInTranscript, parseCommitResult, parsePushResult } from './chat-commits';

function row(
  id: string,
  seq: number,
  role: 'user' | 'assistant',
  blocks: ChatMessageView['blocks'],
  turnId = 't1'
): ChatMessageView {
  return {
    id,
    turnId,
    seq,
    role,
    kind: role === 'assistant' ? 'assistant' : 'tool_results',
    status: 'complete',
    blocks,
    llmModelId: null,
    provider: null,
    model: null,
    stopReason: null,
    usage: null,
    error: null,
    createdAt: `2026-09-01T10:00:0${seq}.000Z`,
    attachments: [],
  };
}

describe('parseCommitResult / parsePushResult', () => {
  it('reads the commit tool’s first line', () => {
    expect(parseCommitResult('Committed on feat/login: 1a2b3c4 Fix the timeout\n')).toEqual({
      branch: 'feat/login',
      sha: '1a2b3c4',
      subject: 'Fix the timeout',
    });
    expect(parseCommitResult('Nothing to commit.')).toBeNull();
  });

  it('reads the push tool’s first line, whatever follows it', () => {
    expect(
      parsePushResult(
        'Pushed feat/login to origin/feat/login.\nremote: ...\n\nTo open a pull request: …'
      )
    ).toEqual({ branch: 'feat/login', remoteBranch: 'feat/login' });
    expect(parsePushResult('The push was refused.')).toBeNull();
  });
});

describe('commitsInTranscript', () => {
  it('lists successful commits in order and marks the ones a later push of their branch carried', () => {
    const messages: ChatMessageView[] = [
      row('a1', 3, 'assistant', [
        { type: 'tool_use', id: 'c1', name: 'code_git_commit', input: { message: 'one' } },
      ]),
      row('r1', 4, 'user', [
        { type: 'tool_result', toolUseId: 'c1', content: 'Committed on feat/x: aaaaaaa one' },
      ]),
      row('a2', 5, 'assistant', [
        { type: 'tool_use', id: 'c2', name: 'code_git_commit', input: { message: 'two' } },
        { type: 'tool_use', id: 'c3', name: 'code_git_commit', input: { message: 'nope' } },
      ]),
      row('r2', 6, 'user', [
        { type: 'tool_result', toolUseId: 'c2', content: 'Committed on feat/x: bbbbbbb two' },
        { type: 'tool_result', toolUseId: 'c3', content: 'Nothing to commit.', isError: true },
      ]),
      row('a3', 7, 'assistant', [{ type: 'tool_use', id: 'p1', name: 'code_git_push', input: {} }]),
      row('r3', 8, 'user', [
        { type: 'tool_result', toolUseId: 'p1', content: 'Pushed feat/x to origin/feat/x.' },
      ]),
      row(
        'a4',
        9,
        'assistant',
        [{ type: 'tool_use', id: 'c4', name: 'code_git_commit', input: { message: 'three' } }],
        't2'
      ),
      row(
        'r4',
        10,
        'user',
        [{ type: 'tool_result', toolUseId: 'c4', content: 'Committed on feat/x: ccccccc three' }],
        't2'
      ),
    ];
    // Out of order on purpose: the transcript is sorted by seq first.
    expect(commitsInTranscript([...messages].reverse())).toEqual([
      expect.objectContaining({
        sha: 'aaaaaaa',
        subject: 'one',
        branch: 'feat/x',
        pushedInChat: true,
        turnId: 't1',
        toolUseId: 'c1',
      }),
      expect.objectContaining({ sha: 'bbbbbbb', subject: 'two', pushedInChat: true }),
      expect.objectContaining({
        sha: 'ccccccc',
        subject: 'three',
        pushedInChat: false,
        turnId: 't2',
      }),
    ]);
  });

  it('ignores a commit whose result has not arrived yet', () => {
    const messages = [
      row('a1', 1, 'assistant', [
        { type: 'tool_use', id: 'c1', name: 'code_git_commit', input: { message: 'one' } },
      ]),
    ];
    expect(commitsInTranscript(messages)).toEqual([]);
  });
});

describe('commitsInTranscript with the code pane’s notes', () => {
  it('counts a commit the person made from the pane, and a push of it', () => {
    const note = (id: string, seq: number, text: string): ChatMessageView => ({
      ...row(id, seq, 'user', [{ type: 'text', text }], 't-none'),
      turnId: null,
      kind: 'note',
    });
    const commits = commitsInTranscript([
      note('n1', 1, 'Committed on feat/pane: 9f9f9f9 Tidy the tree\nNote from the editor: …'),
      note('n2', 2, 'Pushed feat/pane to origin/feat/pane.\nNote from the editor: …'),
    ]);
    expect(commits).toEqual([
      expect.objectContaining({
        sha: '9f9f9f9',
        branch: 'feat/pane',
        subject: 'Tidy the tree',
        toolUseId: 'n1',
        pushedInChat: true,
      }),
    ]);
  });
});

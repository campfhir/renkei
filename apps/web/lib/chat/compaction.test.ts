import {
  foldCandidates,
  needsCompaction,
  CHAT_COMPACT_CHAR_THRESHOLD,
  CHAT_COMPACT_KEEP_RECENT,
  CHAT_COMPACT_MIN_FOLD,
} from './compaction';
import type { StoredMessage } from './messages';

function row(partial: Partial<StoredMessage> & Pick<StoredMessage, 'seq' | 'role'>): StoredMessage {
  return {
    id: `m${partial.seq}`,
    chatId: 'c',
    turnId: 't',
    kind: partial.role === 'assistant' ? 'assistant' : 'prompt',
    status: 'complete',
    blocks: [{ type: 'text', text: 'hi' }],
    llmModelId: 'model-1',
    provider: 'anthropic',
    model: 'x',
    stopReason: null,
    usage: null,
    timing: null,
    error: null,
    summaryId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...partial,
  };
}

/** A message carrying `chars` of text — enough rows of these cross the threshold quickly. */
function bigRow(seq: number, chars: number, partial: Partial<StoredMessage> = {}): StoredMessage {
  return row({
    seq,
    role: seq % 2 === 1 ? 'user' : 'assistant',
    blocks: [{ type: 'text', text: 'x'.repeat(chars) }],
    ...partial,
  });
}

describe('needsCompaction', () => {
  it('is false for a short, small chat', () => {
    const messages = Array.from({ length: 10 }, (_, i) => row({ seq: i + 1, role: 'user' }));
    expect(needsCompaction(messages)).toBe(false);
  });

  it('is false when over the char threshold but too few messages sit outside the keep-recent window', () => {
    // All the bulk lives inside the always-verbatim recent window: nothing to fold yet.
    const count = CHAT_COMPACT_KEEP_RECENT;
    const perMessage = Math.ceil(CHAT_COMPACT_CHAR_THRESHOLD / count) + 1;
    const messages = Array.from({ length: count }, (_, i) => bigRow(i + 1, perMessage));
    expect(needsCompaction(messages)).toBe(false);
  });

  it('is true once enough messages sit outside the keep-recent window and the total crosses the threshold', () => {
    const count = CHAT_COMPACT_KEEP_RECENT + CHAT_COMPACT_MIN_FOLD;
    const perMessage = Math.ceil(CHAT_COMPACT_CHAR_THRESHOLD / count) + 1;
    const messages = Array.from({ length: count }, (_, i) => bigRow(i + 1, perMessage));
    expect(needsCompaction(messages)).toBe(true);
  });

  it('ignores messages already folded into a summary, for both the count and the char total', () => {
    const count = CHAT_COMPACT_KEEP_RECENT + CHAT_COMPACT_MIN_FOLD;
    const perMessage = Math.ceil(CHAT_COMPACT_CHAR_THRESHOLD / count) + 1;
    const messages = Array.from({ length: count }, (_, i) =>
      bigRow(i + 1, perMessage, { summaryId: 'already-folded' })
    );
    expect(needsCompaction(messages)).toBe(false);
  });

  it('ignores failed rows', () => {
    const count = CHAT_COMPACT_KEEP_RECENT + CHAT_COMPACT_MIN_FOLD;
    const perMessage = Math.ceil(CHAT_COMPACT_CHAR_THRESHOLD / count) + 1;
    const messages = Array.from({ length: count }, (_, i) =>
      bigRow(i + 1, perMessage, { status: 'failed' })
    );
    expect(needsCompaction(messages)).toBe(false);
  });
});

describe('foldCandidates', () => {
  const count = CHAT_COMPACT_KEEP_RECENT + CHAT_COMPACT_MIN_FOLD + 1;
  // The boundary the window alone would pick: this many oldest rows.
  const cut = count - CHAT_COMPACT_KEEP_RECENT;

  function rows(atBoundary: 'round' | 'prose'): StoredMessage[] {
    return Array.from({ length: count }, (_, i) => {
      const seq = i + 1;
      if (atBoundary === 'round' && seq === cut) {
        return row({
          seq,
          role: 'assistant',
          blocks: [{ type: 'tool_use', id: 'call', name: 'code_read_file', input: {} }],
        });
      }
      if (atBoundary === 'round' && seq === cut + 1) {
        return row({
          seq,
          role: 'user',
          kind: 'tool_results',
          blocks: [{ type: 'tool_result', toolUseId: 'call', content: 'text' }],
        });
      }
      return row({ seq, role: seq % 2 === 1 ? 'user' : 'assistant' });
    });
  }

  it('takes the oldest rows outside the recent window', () => {
    expect(foldCandidates(rows('prose')).map((message) => message.seq)).toEqual(
      Array.from({ length: cut }, (_, i) => i + 1)
    );
  });

  it('never cuts between a call and its results: the results row folds too', () => {
    const picked = foldCandidates(rows('round'));
    expect(picked.map((message) => message.seq)).toEqual(
      Array.from({ length: cut + 1 }, (_, i) => i + 1)
    );
    expect(picked[picked.length - 1].kind).toBe('tool_results');
  });
});

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

  it('folds a results row inside the window, and does not count it toward the window', () => {
    // Rows cut+2..count are 19 conversation rows; the call at `cut` is the
    // 20th and opens the window. Its results row sits inside the window and
    // folds anyway; the call's own row stays (buildHistory drops the
    // unanswered tool_use).
    const picked = foldCandidates(rows('round')).map((message) => message.seq);
    expect(picked).toEqual([...Array.from({ length: cut - 1 }, (_, i) => i + 1), cut + 1]);
  });

  it('folds every tool-results row in the window and keeps the conversation verbatim', () => {
    // A tool-heavy recent stretch: prose, then rounds of call + results.
    const messages: StoredMessage[] = [];
    let seq = 0;
    for (let i = 0; i < CHAT_COMPACT_KEEP_RECENT; i += 1) {
      seq += 1;
      messages.push(
        row({
          seq,
          role: 'assistant',
          blocks: [
            { type: 'text', text: `checking ${i}` },
            { type: 'tool_use', id: `c${i}`, name: 'mirth_list_events', input: {} },
          ],
        })
      );
      seq += 1;
      messages.push(
        row({
          seq,
          role: 'user',
          kind: 'tool_results',
          blocks: [{ type: 'tool_result', toolUseId: `c${i}`, content: 'x'.repeat(50_000) }],
        })
      );
    }
    const picked = foldCandidates(messages);
    expect(picked.length).toBe(CHAT_COMPACT_KEEP_RECENT);
    expect(picked.every((message) => message.kind === 'tool_results')).toBe(true);
    // Its total is all tool output, inside what used to be the untouchable window.
    expect(needsCompaction(messages)).toBe(true);
    // Once folded, what is left is small and does not trigger again.
    const folded = messages.map((message) =>
      message.kind === 'tool_results' ? { ...message, summaryId: 's1' } : message
    );
    expect(foldCandidates(folded.filter((message) => message.summaryId === null))).toEqual([]);
    expect(needsCompaction(folded)).toBe(false);
  });
});

describe('needsCompaction with a recorded context window', () => {
  const count = CHAT_COMPACT_KEEP_RECENT + CHAT_COMPACT_MIN_FOLD;
  const budget = { contextWindow: 200_000, maxOutputTokens: 4_096 };
  const small = () => Array.from({ length: count }, (_, i) => bigRow(i + 1, 100));
  /** The newest reply carries what its call measured. */
  const measured = (inputTokens: number, summaryAt: Date | null = null) => {
    const messages = small();
    messages[count - 1] = bigRow(count, 100, {
      status: 'complete',
      usage: { inputTokens, outputTokens: 500 },
      updatedAt: new Date(1_000),
    });
    return {
      messages,
      budget: { ...budget, summary: summaryAt ? { createdAt: summaryAt, chars: 0 } : null },
    };
  };

  it('leaves a large-window model alone past the old character threshold', () => {
    const perMessage = Math.ceil(CHAT_COMPACT_CHAR_THRESHOLD / count) + 1;
    const messages = Array.from({ length: count }, (_, i) => bigRow(i + 1, perMessage));
    expect(needsCompaction(messages)).toBe(true);
    expect(needsCompaction(messages, { ...budget, contextWindow: 1_000_000 })).toBe(false);
  });

  it('catches a small-window model well before the old threshold', () => {
    const messages = Array.from({ length: count }, (_, i) => bigRow(i + 1, 5_000));
    expect(needsCompaction(messages)).toBe(false);
    expect(needsCompaction(messages, { ...budget, contextWindow: 32_000 })).toBe(true);
  });

  it('trusts the last reply’s measured usage over the text size', () => {
    const near = measured(170_000);
    expect(needsCompaction(near.messages, near.budget)).toBe(true);
    const roomy = measured(100_000);
    expect(needsCompaction(roomy.messages, roomy.budget)).toBe(false);
  });

  it('ignores a measurement taken before the newest fold', () => {
    const stale = measured(170_000, new Date(2_000));
    expect(needsCompaction(stale.messages, stale.budget)).toBe(false);
  });

  it('never compacts when too few messages could be folded', () => {
    const messages = Array.from({ length: CHAT_COMPACT_KEEP_RECENT }, (_, i) => bigRow(i + 1, 50_000));
    expect(needsCompaction(messages, { ...budget, contextWindow: 32_000 })).toBe(false);
  });
});

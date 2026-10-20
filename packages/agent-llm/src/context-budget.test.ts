import type { LlmMessage } from './contract';
import {
  MIN_TRANSCRIPT_CHARS,
  contextWindowOf,
  fitMessages,
  messagesChars,
  transcriptBudgetChars,
} from './context-budget';

function exchange(index: number, resultChars: number, inputChars = 20): LlmMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Turn ${index}` },
        { type: 'tool_use', id: `t${index}`, name: 'read', input: { q: 'x'.repeat(inputChars) } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: `t${index}`,
          content: `R${index}:${'y'.repeat(resultChars)}:END${index}`,
        },
      ],
    },
  ];
}

const opening: LlmMessage = { role: 'user', content: [{ type: 'text', text: 'Do the work.' }] };

describe('contextWindowOf', () => {
  it('takes the operator setting, then the model family, then a safe default', () => {
    expect(contextWindowOf('anything', { contextWindowTokens: 32_000 })).toBe(32_000);
    expect(contextWindowOf('claude-sonnet-5-5')).toBe(200_000);
    expect(contextWindowOf('claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(contextWindowOf('gpt-4.1-mini')).toBe(1_000_000);
    expect(contextWindowOf('gpt-4o')).toBe(128_000);
    expect(contextWindowOf('my-local-llama')).toBe(128_000);
  });

  it('turns a window into a character budget with room for the reply and the fixed prompt', () => {
    expect(
      transcriptBudgetChars({
        contextWindowTokens: 200_000,
        maxOutputTokens: 8_000,
        fixedChars: 20_000,
      })
    ).toBe(Math.floor(192_000 * 3 * 0.9) - 20_000);
    expect(
      transcriptBudgetChars({ contextWindowTokens: 8_000, maxOutputTokens: 4_000, fixedChars: 0 })
    ).toBe(MIN_TRANSCRIPT_CHARS);
  });
});

describe('fitMessages', () => {
  it('leaves a conversation that fits alone', () => {
    const messages = [opening, ...exchange(1, 100)];
    const fitted = fitMessages(messages, 10_000);
    expect(fitted.cut).toBe(0);
    expect(fitted.messages).toEqual(messages);
  });

  it('elides old results first and keeps the recent window whole when that is enough', () => {
    const messages = [
      opening,
      ...exchange(1, 30_000),
      ...exchange(2, 30_000),
      ...exchange(3, 1_000),
      ...exchange(4, 1_000),
      ...exchange(5, 1_000),
    ];
    const fitted = fitMessages(messages, 20_000);
    expect(messagesChars(fitted.messages)).toBeLessThanOrEqual(20_000);
    const text = JSON.stringify(fitted.messages);
    expect(text).toContain('earlier result elided');
    // The last three exchanges are untouched.
    expect(fitted.messages.slice(-6)).toEqual(messages.slice(-6));
    // Nothing is dropped: same messages, same blocks, same tool pairing.
    expect(fitted.messages.map((m) => m.content.length)).toEqual(
      messages.map((m) => m.content.length)
    );
    // The input was not modified.
    const original = messages[2].content[0];
    expect(original.type === 'tool_result' && original.content.length).toBeGreaterThan(30_000);
  });

  it('cuts a single oversized recent turn to fit, head and tail kept and the cut said', () => {
    // One turn that is too big by itself: four 40 000-character reads in one reply.
    const turn: LlmMessage[] = [
      {
        role: 'assistant',
        content: [0, 1, 2, 3].map((i) => ({
          type: 'tool_use' as const,
          id: `r${i}`,
          name: 'read',
          input: {},
        })),
      },
      {
        role: 'user',
        content: [0, 1, 2, 3].map((i) => ({
          type: 'tool_result' as const,
          toolUseId: `r${i}`,
          content: `HEAD${i}${'z'.repeat(40_000)}TAIL${i}`,
        })),
      },
    ];
    const fitted = fitMessages([opening, ...turn], 60_000);
    expect(messagesChars(fitted.messages)).toBeLessThanOrEqual(60_000);
    const results = fitted.messages[2].content;
    expect(results).toHaveLength(4);
    for (const [i, block] of results.entries()) {
      if (block.type !== 'tool_result') throw new Error('expected a result');
      expect(block.toolUseId).toBe(`r${i}`);
      expect(block.content.startsWith(`HEAD${i}`)).toBe(true);
      expect(block.content.endsWith(`TAIL${i}`)).toBe(true);
      expect(block.content).toContain('characters cut from the middle of this result');
    }
  });

  it('elides a huge old tool input, and never edits thinking blocks', () => {
    const messages: LlmMessage[] = [
      opening,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan '.repeat(2_000), signature: 'sig' },
          { type: 'tool_use', id: 'w', name: 'write_note', input: { body: 'n'.repeat(50_000) } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'w', content: 'saved' }] },
      ...exchange(2, 100),
      ...exchange(3, 100),
      ...exchange(4, 100),
    ];
    const fitted = fitMessages(messages, 20_000);
    expect(fitted.messages[1].content[0]).toEqual(messages[1].content[0]);
    expect(fitted.messages[1].content[1]).toMatchObject({
      type: 'tool_use',
      id: 'w',
      input: { _elided: expect.stringContaining('characters of arguments') },
    });
    expect(messagesChars(fitted.messages)).toBeLessThanOrEqual(20_000);
  });
});

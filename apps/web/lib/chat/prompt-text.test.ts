/**
 * The person's own message for the running turn: the latest one, in their
 * exact words, rejoined when a long paste was stored in pieces, and never
 * the assistant's or a tool's.
 */

import { latestUserPrompt } from './prompt-text';

const row = (role: string, kind: string, ...texts: string[]) => ({
  role,
  kind,
  blocks: texts.map((text) => ({ type: 'text' as const, text })),
});

describe('latestUserPrompt', () => {
  it('is the last thing the person typed, word for word', () => {
    expect(
      latestUserPrompt([
        row('user', 'prompt', 'earlier question'),
        row('assistant', 'assistant', 'an answer'),
        row('user', 'prompt', 'generate a picture of a cute polarbear'),
      ])
    ).toBe('generate a picture of a cute polarbear');
  });

  it('skips the assistant, tool results, nudges and notes after it', () => {
    expect(
      latestUserPrompt([
        row('user', 'prompt', 'draw a fox'),
        row('assistant', 'assistant', 'calling the tool'),
        row('user', 'tool_results'),
        row('user', 'nudge', 'carry on'),
        row('user', 'note', 'a note'),
      ])
    ).toBe('draw a fox');
  });

  it('rejoins a long paste stored across several prompt rows', () => {
    expect(
      latestUserPrompt([
        row('assistant', 'assistant', 'hi'),
        row('user', 'prompt', 'part one, '),
        row('user', 'prompt', 'part two'),
      ])
    ).toBe('part one, part two');
  });

  it('is empty when the person has typed nothing', () => {
    expect(latestUserPrompt([])).toBe('');
    expect(latestUserPrompt([row('assistant', 'assistant', 'hello')])).toBe('');
  });

  it('keeps inner whitespace and line breaks, trimming only the ends', () => {
    expect(latestUserPrompt([row('user', 'prompt', '  a bear\n\nin snow  ')])).toBe(
      'a bear\n\nin snow'
    );
  });
});

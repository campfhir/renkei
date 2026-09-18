/**
 * What a reply sounds like: the Markdown that makes it readable on screen
 * must not be read out loud. Each case is one piece of syntax a voice
 * would otherwise pronounce, and what a listener hears instead.
 */

import { CODE_OMITTED, speakableText } from './speech-text';

describe('speakableText', () => {
  it('drops heading marks, emphasis and inline code but keeps the words', () => {
    expect(speakableText('## Plan\n\nRun **now**, then _wait_ for `deploy`.')).toBe(
      'Plan. Run now, then wait for deploy.'
    );
  });

  it('reads list items as sentences', () => {
    expect(speakableText('- First thing\n- Second thing!\n1. Third\n- [x] Done')).toBe(
      'First thing. Second thing! Third. Done.'
    );
  });

  it('says a code block is omitted rather than reading it', () => {
    expect(speakableText('Try this:\n\n```ts\nconst x = 1;\n```\n\nThen run it.')).toBe(
      `Try this: ${CODE_OMITTED} Then run it.`
    );
  });

  it('treats an unclosed fence at the end of a stream as a code block', () => {
    expect(speakableText('Here:\n```py\nprint(1)\n')).toBe(`Here: ${CODE_OMITTED}`);
  });

  it('speaks a link by its label and a bare URL as "link"', () => {
    expect(speakableText('See [the runbook](https://x.y/z) or https://a.b/c now.')).toBe(
      'See the runbook or link now.'
    );
  });

  it('reads a table row by row and skips the separator', () => {
    expect(speakableText('| Name | Count |\n| --- | ---: |\n| Jira | 3 |')).toBe(
      'Name, Count. Jira, 3.'
    );
  });

  it('strips block quotes, rules and HTML', () => {
    expect(speakableText('> Quoted\n\n---\n\n<br>Plain <b>bold</b>')).toBe('Quoted. Plain bold.');
  });

  it('keeps an asterisk that is arithmetic, not emphasis', () => {
    expect(speakableText('2 * 3 = 6')).toBe('2 * 3 = 6.');
  });

  it('returns nothing for nothing', () => {
    expect(speakableText('')).toBe('');
    expect(speakableText('\n\n  \n')).toBe('');
  });
});

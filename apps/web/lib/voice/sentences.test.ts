/**
 * Where a streaming reply is cut for the voice. The cuts decide how soon
 * the first words are heard and whether a sentence is ever spoken in two
 * halves, so each rule here is one thing a listener would notice.
 */

import { MAX_CHUNK_CHARS, takeSpeakable } from './sentences';

const LONG = 'This sentence is comfortably longer than the minimum chunk size, yes it is.';

describe('takeSpeakable', () => {
  it('hands back complete sentences and keeps the unfinished tail', () => {
    const result = takeSpeakable(`${LONG} And here is the start of anoth`);
    expect(result.chunks).toEqual([LONG]);
    expect(result.rest).toBe('And here is the start of anoth');
  });

  it('waits when nothing has closed yet', () => {
    expect(takeSpeakable('Still typing')).toEqual({ chunks: [], rest: 'Still typing' });
  });

  it('speaks the tail once the turn is over', () => {
    expect(takeSpeakable('Last words', { final: true })).toEqual({
      chunks: ['Last words'],
      rest: '',
    });
  });

  it('lets a short sentence ride with the next rather than going alone', () => {
    const result = takeSpeakable(`Yes. ${LONG} `);
    expect(result.chunks).toEqual([`Yes. ${LONG}`]);
  });

  it('holds a short sentence back while more is coming, but not at the end', () => {
    expect(takeSpeakable('Yes. No')).toEqual({ chunks: [], rest: 'Yes. No' });
    expect(takeSpeakable('Yes. No', { final: true })).toEqual({ chunks: ['Yes. No'], rest: '' });
  });

  it('treats a blank line as a boundary even without punctuation', () => {
    const result = takeSpeakable(`${LONG.replace(/\.$/, '')}\n\nNext paragraph begins`);
    expect(result.chunks).toEqual([LONG.replace(/\.$/, '')]);
    expect(result.rest).toBe('Next paragraph begins');
  });

  it('never cuts inside an open code fence', () => {
    const open = `${LONG} Look:\n\`\`\`ts\nconst a = 1. Really.\n`;
    expect(takeSpeakable(open)).toEqual({ chunks: [], rest: open });
    const closed = `${open}\`\`\`\n\nDone now, that is all of it, nothing further to add.`;
    const result = takeSpeakable(closed);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[1]).toContain('```');
    expect(result.rest).toBe('');
  });

  it('starts a reply on its first clause rather than waiting for the sentence', () => {
    const opening =
      'A Palo Alto firewall sits at the boundary of a network — between your internal systems and the outside';
    expect(takeSpeakable(opening, { first: true })).toEqual({
      chunks: ['A Palo Alto firewall sits at the boundary of a network —'],
      rest: 'between your internal systems and the outside',
    });
    // Only the first piece: after it, sentences are the unit again.
    expect(takeSpeakable(opening)).toEqual({ chunks: [], rest: opening });
  });

  it('waits for a clause long enough to be worth saying, and never cuts a number', () => {
    expect(takeSpeakable('Yes, of course, it is', { first: true })).toEqual({
      chunks: [],
      rest: 'Yes, of course, it is',
    });
    const figures = 'The budget for the quarter came to 1,250,000 across the three teams, which';
    expect(takeSpeakable(figures, { first: true })).toEqual({
      chunks: ['The budget for the quarter came to 1,250,000 across the three teams,'],
      rest: 'which',
    });
  });

  it('prefers a closed sentence to a clause when the reply opens with one', () => {
    const result = takeSpeakable(`${LONG} Then, after that`, { first: true });
    expect(result.chunks).toEqual([LONG]);
    expect(result.rest).toBe('Then, after that');
  });

  it('splits one enormous sentence at spaces under the cap', () => {
    const words = Array.from({ length: 900 }, (_, index) => `word${index}`).join(' ');
    const result = takeSpeakable(`${words}.`);
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(result.chunks.join(' ')).toBe(`${words}.`);
  });
});

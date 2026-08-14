/**
 * Splitting a chunk into headings and prose.
 *
 * Half these tests are about restraint. The knowledge store holds mail,
 * transcripts and extracted documents alongside the markdown a connector
 * writes, and a renderer that guesses at intent would eat an author's
 * asterisks and reflow their line breaks. Exactly one construct is
 * recognised; everything else has to survive untouched.
 */

import { parseBlocks, withoutEchoedTitle } from './content-blocks';

describe('parseBlocks', () => {
  it('separates headings from the text under them', () => {
    const blocks = parseBlocks('# Login fails\n\n## Description\n\nUsers cannot sign in.');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Login fails' },
      { kind: 'heading', level: 2, text: 'Description' },
      { kind: 'text', level: 0, text: 'Users cannot sign in.' },
    ]);
  });

  it('keeps a run of lines together so line breaks survive', () => {
    // A field list and a transcript both depend on this.
    const blocks = parseBlocks('## Fields\n\nKey: SUP-1\nStatus: Open\nLabels: a, b');
    expect(blocks[1]?.text).toBe('Key: SUP-1\nStatus: Open\nLabels: a, b');
  });

  it('leaves ordinary prose entirely alone', () => {
    const email = 'Hi Dana,\n\nthe *only* option left is a rollback — see plan_v2.md.\n\nPriya';
    expect(parseBlocks(email)).toEqual([{ kind: 'text', level: 0, text: email }]);
  });

  it('does not treat a hash without a space as a heading', () => {
    // "#4821" is a ticket reference, "#general" a channel.
    const text = 'Ref #4821 raised in #general';
    expect(parseBlocks(text)).toEqual([{ kind: 'text', level: 0, text }]);
  });

  it('ignores a hash line with nothing after it', () => {
    expect(parseBlocks('###\n\nstill text')).toEqual([
      { kind: 'text', level: 0, text: '###\n\nstill text' },
    ]);
  });

  it('handles content with no headings at all', () => {
    expect(parseBlocks('just one line')).toEqual([
      { kind: 'text', level: 0, text: 'just one line' },
    ]);
  });

  it('drops nothing when text is empty', () => {
    expect(parseBlocks('')).toEqual([]);
  });
});

describe('withoutEchoedTitle', () => {
  const blocks = (text: string) => parseBlocks(text);

  it('drops a leading heading that restates the card title', () => {
    // The duplication that made these cards useless: the card already says
    // "SUP-4821: Login fails after SSO migration".
    const result = withoutEchoedTitle(
      blocks('# Login fails after SSO migration\n\n## Description\n\nDetail.'),
      'SUP-4821: Login fails after SSO migration'
    );
    expect(result[0]).toEqual({ kind: 'heading', level: 2, text: 'Description' });
  });

  it('keeps a leading heading that says something new', () => {
    const result = withoutEchoedTitle(blocks('# Root cause\n\nDetail.'), 'SUP-4821: Login fails');
    expect(result[0]).toEqual({ kind: 'heading', level: 1, text: 'Root cause' });
  });

  it('keeps a later heading even when it matches the title', () => {
    // Only the first block is an echo; a match further down is real content.
    const result = withoutEchoedTitle(
      blocks('## Description\n\nDetail.\n\n# Login fails'),
      'SUP-4821: Login fails'
    );
    expect(result).toHaveLength(3);
  });

  it('leaves prose alone when it is not the title', () => {
    const result = withoutEchoedTitle(blocks('Users cannot sign in.'), 'OPS-1042: Login fails');
    expect(result).toHaveLength(1);
  });
});

describe('withoutEchoedTitle — content indexed before structured documents', () => {
  it('drops a bare first line that repeats the title', () => {
    // Every Jira issue indexed by the old builder opens with a copy of its
    // own title, and those chunks stay in the index until re-read.
    const result = withoutEchoedTitle(
      parseBlocks('OPS-1042: Nightly export review\n\nStatus: Resolved'),
      'OPS-1042: Nightly export review'
    );
    expect(result).toEqual([{ kind: 'text', level: 0, text: 'Status: Resolved' }]);
  });

  it('keeps the rest of the block it trimmed', () => {
    const result = withoutEchoedTitle(
      parseBlocks('A subject line\nthen the body\nand more'),
      'A subject line'
    );
    expect(result[0]?.text).toBe('then the body\nand more');
  });

  it('leaves the block alone when nothing was duplicated', () => {
    const text = 'Users cannot sign in.\n\nAffects the finance group.';
    expect(withoutEchoedTitle(parseBlocks(text), 'OPS-1042: Login fails')).toEqual(
      parseBlocks(text)
    );
  });

  it('drops the block entirely when the title was all it held', () => {
    expect(
      withoutEchoedTitle(parseBlocks('OPS-1042: Login fails'), 'OPS-1042: Login fails')
    ).toEqual([]);
  });
});

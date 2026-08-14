/**
 * Nesting one author's headings inside our document.
 *
 * The failure this prevents is not cosmetic: a comment containing `## Fields`
 * reads, to the page and to a model, as the issue's real field list.
 */

import { demoteHeadings } from './adf';

describe('demoteHeadings', () => {
  it('pushes every heading down by the given amount', () => {
    expect(demoteHeadings('# Overview', 2)).toBe('### Overview');
    expect(demoteHeadings('## Detail', 3)).toBe('##### Detail');
  });

  it('stops a comment from impersonating a section of the document', () => {
    expect(demoteHeadings('## Fields\n\nnot really', 3)).toBe('##### Fields\n\nnot really');
  });

  it('leaves the text of a heading alone', () => {
    expect(demoteHeadings('# Steps to reproduce', 2)).toBe('### Steps to reproduce');
  });

  it('leaves everything that is not a heading', () => {
    const text = 'Ref #4821 in #general\n\n- bullet\n\n  indented';
    expect(demoteHeadings(text, 3)).toBe(text);
  });

  it('does not rewrite comments inside fenced code', () => {
    // These are shell comments, not headings. Rewriting them corrupts the
    // snippet the author pasted.
    const text = [
      'Try this:',
      '',
      '```bash',
      '# install first',
      'npm i',
      '```',
      '',
      '# Real heading',
    ].join('\n');
    const out = demoteHeadings(text, 2);
    expect(out).toContain('# install first');
    expect(out).not.toContain('### install first');
    expect(out).toContain('### Real heading');
  });

  it('handles tilde fences too', () => {
    const text = '~~~\n# not a heading\n~~~';
    expect(demoteHeadings(text, 2)).toBe(text);
  });

  it('clamps at markdown’s floor of six', () => {
    expect(demoteHeadings('##### Deep', 3)).toBe('###### Deep');
    expect(demoteHeadings('###### Deepest', 3)).toBe('###### Deepest');
  });

  it('requires a space, so a tag is not a heading', () => {
    expect(demoteHeadings('#4821 is blocked', 2)).toBe('#4821 is blocked');
  });

  it('is a no-op for zero or empty input', () => {
    expect(demoteHeadings('# Heading', 0)).toBe('# Heading');
    expect(demoteHeadings('', 3)).toBe('');
  });
});

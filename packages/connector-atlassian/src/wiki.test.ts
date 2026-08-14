/**
 * Jira wiki markup → Markdown.
 *
 * The load-bearing case is `#`. In wiki it starts an ordered list item; in
 * Markdown it is a heading. Passed through untranslated, a real change
 * ticket's four-step backout plan became four headings — and once demoted to
 * nest under their section, four headings of the wrong depth with no order.
 */

import { wikiToMarkdown, looksLikeWikiMarkup } from './wiki';

describe('wikiToMarkdown', () => {
  it('turns wiki ordered items into ordered items, not headings', () => {
    const out = wikiToMarkdown('# Redeploy the previous image\n# No database rollback required');
    expect(out).toBe('1. Redeploy the previous image\n1. No database rollback required');
    expect(out).not.toContain('# Redeploy');
  });

  it('indents nested list depth', () => {
    expect(wikiToMarkdown('# One\n## One a')).toBe('1. One\n   1. One a');
    expect(wikiToMarkdown('* One\n** One a')).toBe('- One\n  - One a');
  });

  it('converts wiki headings, which are hN. not hashes', () => {
    expect(wikiToMarkdown('h1. Overview')).toBe('# Overview');
    expect(wikiToMarkdown('h3. Detail')).toBe('### Detail');
  });

  it('converts monospace to code, keeping commands intact', () => {
    expect(wikiToMarkdown('Run {{pnpm test}} then {{pnpm lint}}')).toBe(
      'Run `pnpm test` then `pnpm lint`'
    );
  });

  it('leaves a leading hash inside a code block alone', () => {
    // A shell comment is not a list item.
    const out = wikiToMarkdown('{code}\n# install first\nnpm i\n{code}');
    expect(out).toContain('# install first');
    expect(out).not.toContain('1. install first');
  });

  it('does not touch emphasis', () => {
    // `*Security Review:*` is bold in wiki and italic in Markdown — wrong but
    // harmless. Guessing at it risks mangling ordinary prose.
    expect(wikiToMarkdown('*Security Review:*')).toBe('*Security Review:*');
    expect(wikiToMarkdown('_Trigger:_ container fails')).toBe('_Trigger:_ container fails');
  });

  it('needs a space after the marker, so a tag stays a tag', () => {
    expect(wikiToMarkdown('Ref #4821 is blocked')).toBe('Ref #4821 is blocked');
    expect(wikiToMarkdown('2*3 is six')).toBe('2*3 is six');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'Account unlocks are performed manually today.\n\nNo schema changes.';
    expect(wikiToMarkdown(prose)).toBe(prose);
  });

  it('handles empty input', () => {
    expect(wikiToMarkdown('')).toBe('');
  });
});

describe('looksLikeWikiMarkup', () => {
  it('recognises the markers only wiki has', () => {
    expect(looksLikeWikiMarkup('h2. Overview')).toBe(true);
    expect(looksLikeWikiMarkup('Run {{pnpm test}}')).toBe(true);
    expect(looksLikeWikiMarkup('{code}\nx\n{code}')).toBe(true);
  });

  it('does not claim ordinary prose', () => {
    expect(looksLikeWikiMarkup('Just a sentence.')).toBe(false);
  });
});

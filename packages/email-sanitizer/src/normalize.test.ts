/**
 * The HTML linearizer's scanners, which replaced two regexes CodeQL flagged
 * as quadratic on hostile input: their behaviour on the ordinary shapes and
 * on the edge cases the regexes defined (an unclosed element, `<>`, an
 * unclosed `<`), and that a pathological body finishes at once.
 */

import { htmlToText, stripTags } from './normalize';

describe('htmlToText', () => {
  it('drops script and style elements whole, in any case, and strips the rest of the tags', () => {
    expect(
      htmlToText('<p>Hello</p><STYLE type="text/css">p { color: red }</STYLE><script>alert(1)</script><b>there</b>')
    ).toBe('Hello\nthere');
  });

  it('keeps the text of a style element that never closes, as the regex did', () => {
    expect(htmlToText('<style>p {}<p>after')).toBe('p {}after');
  });

  it('finishes at once on a body made of unclosed openers', () => {
    const hostile = '<style'.repeat(50_000);
    const started = Date.now();
    expect(htmlToText(hostile)).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('stripTags', () => {
  it('removes tags and leaves `<>` and an unclosed `<` alone', () => {
    expect(stripTags('a <b>bold</b> c')).toBe('a bold c');
    expect(stripTags('1 < 2', ' ')).toBe('1 < 2');
    expect(stripTags('<> stays, <b>this</b> goes', ' ')).toBe('<> stays,  this  goes');
    expect(stripTags('<a<b>c')).toBe('c');
  });

  it('finishes at once on a body made of `<`', () => {
    const hostile = '<'.repeat(200_000) + 'x';
    const started = Date.now();
    expect(stripTags(hostile)).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/**
 * The Markdown an email body is written in, and what Outlook (and the
 * preview card's innerHTML) receive for it. The two guards matter most:
 * raw HTML in the source is text, not markup, and only http(s)/mailto
 * links become anchors.
 */

import { markdownToHtml } from './markdown';

describe('markdownToHtml', () => {
  it('renders paragraphs, emphasis and lists', () => {
    expect(markdownToHtml('**Bold** and *italic*\n\n- one\n- two\n\n1. first\n2. second')).toBe(
      '<div><p><strong>Bold</strong> and <em>italic</em></p>\n' +
        '<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n' +
        '<ol>\n<li>first</li>\n<li>second</li>\n</ol></div>'
    );
  });

  it('keeps a single newline as a line break, a blank line as a paragraph', () => {
    expect(markdownToHtml('Hi,\nthere\n\nBye')).toBe('<div><p>Hi,<br>there</p>\n<p>Bye</p></div>');
  });

  it('normalises Windows line endings', () => {
    expect(markdownToHtml('a\r\nb')).toBe('<div><p>a<br>b</p></div>');
  });

  it('escapes raw HTML instead of passing it through', () => {
    expect(markdownToHtml('<b>raw</b> and 3 < 5 & more')).toBe(
      '<div><p>&lt;b&gt;raw&lt;/b&gt; and 3 &lt; 5 &amp; more</p></div>'
    );
    expect(markdownToHtml('<script>alert(1)</script>')).not.toContain('<script');
  });

  it('links http(s) and mailto targets and keeps only the text for anything else', () => {
    expect(markdownToHtml('[docs](https://example.com/x) [me](mailto:a@example.com)')).toBe(
      '<div><p><a href="https://example.com/x">docs</a> <a href="mailto:a@example.com">me</a></p></div>'
    );
    expect(markdownToHtml('[bad](javascript:alert(1)) [rel](/path) [data](data:text/html,x)')).toBe(
      '<div><p>bad rel data</p></div>'
    );
  });

  it('reduces an image to its alt text', () => {
    expect(markdownToHtml('![chart](https://x/y.png)')).toBe('<div><p>chart</p></div>');
  });
});

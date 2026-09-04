/**
 * pageToText's promises: the title is found; the main region wins over
 * the chrome around it, and without one the chrome is dropped; headings,
 * lists, tables, quotes and preformatted blocks keep their shape; links
 * carry their absolute target; scripts, styles and comments never leak;
 * entities are decoded; the cap is honored and reported.
 */

import { decodeEntities, looksLikeHtml, pageTitle, pageToText } from './page-text';

const PAGE = `<!doctype html>
<html><head><title>Status &amp; Uptime — Example</title>
<style>body{color:red}</style><script>window.x = "<p>not text</p>";</script></head>
<body>
<header><a href="/">Home</a> <nav><a href="/a">A</a> <a href="/b">B</a></nav></header>
<main>
  <h1>All systems <em>operational</em></h1>
  <!-- a comment with <b>tags</b> -->
  <p>Last checked <strong>today</strong>. See the <a href="/history?x=1#top">history page</a> and <a href="https://example.com/rss">https://example.com/rss</a>.</p>
  <ul><li>API: up</li><li>Web: up</li></ul>
  <table><tr><th>Region</th><th>Latency</th></tr><tr><td>EU</td><td>20&nbsp;ms</td></tr></table>
  <blockquote><p>Quoted line one.</p><p>Quoted line two.</p></blockquote>
  <pre>  indented
    code &lt;kept&gt;</pre>
  <img src="/chart.png" alt="Latency chart"> <a href="javascript:alert(1)">bad link</a> <a href="#anchor">anchor</a>
  <p>This main region needs to be long enough to be chosen over the body, so here is some more prose to push it past the threshold that separates a marked-up landmark from a decorative one.</p>
</main>
<aside>Related: <a href="/c">C</a></aside>
<footer>© 2026 Example</footer>
</body></html>`;

describe('pageToText', () => {
  it('keeps the main region and drops the chrome, scripts, styles and comments', () => {
    const page = pageToText(PAGE, { maxChars: 10_000, baseUrl: 'https://example.com/status' });
    expect(page.title).toBe('Status & Uptime — Example');
    expect(page.truncated).toBe(false);
    expect(page.text).not.toMatch(/Home|\bA\b \bB\b|Related|© 2026|not text|color:red|a comment/);
    expect(page.text).toContain('# All systems operational');
    expect(page.text).toContain(
      'Last checked today. See the history page (https://example.com/history?x=1) and https://example.com/rss .'
    );
    expect(page.text).toContain('- API: up\n- Web: up');
    expect(page.text).toContain('Region | Latency\nEU | 20 ms');
    expect(page.text).toContain('> Quoted line one.\n> Quoted line two.');
    expect(page.text).toContain('  indented\n    code <kept>');
    expect(page.text).toContain('[image: Latency chart]');
    expect(page.text).toContain('bad link anchor');
    expect(page.text).not.toContain('javascript:');
  });

  it('without a main region, reads the body minus navigation, header, footer and asides', () => {
    const html = `<html><head><title>T</title></head><body><nav>Menu</nav><header>Top</header><div><p>Body text.</p></div><aside>Side</aside><footer>Bottom</footer></body></html>`;
    const page = pageToText(html, { maxChars: 1000 });
    expect(page.text).toBe('Body text.');
  });

  it('caps the text and says so', () => {
    const html = `<p>${'word '.repeat(500)}</p>`;
    const page = pageToText(html, { maxChars: 100 });
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThan(200);
    expect(page.text).toMatch(/\[cut at 100 characters; \d+ more on the page\]$/);
  });

  it('falls back to the first heading for a title and decodes entities', () => {
    expect(pageTitle('<body><h1>Hello &#8212; <i>world</i> &#x263A;</h1></body>')).toBe(
      'Hello — world ☺'
    );
    expect(pageTitle('<body><p>no title</p></body>')).toBeNull();
    expect(decodeEntities('a &lt; b &amp;&amp; c &gt; d &unknown; &euro;5')).toBe(
      'a < b && c > d &unknown; €5'
    );
  });

  it('recognises HTML that arrived without a content type', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html>')).toBe(true);
    expect(looksLikeHtml('  <div class="x">hi</div>')).toBe(true);
    expect(looksLikeHtml('{"json": true}')).toBe(false);
    expect(looksLikeHtml('%PDF-1.4')).toBe(false);
  });
});

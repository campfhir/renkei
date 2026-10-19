/**
 * The crawl extract in a real Chromium when one is at hand (as
 * browser-page-script.test.ts does): visibility and innerText are layout
 * questions a scripted DOM cannot answer. Skipped where no browser is
 * installed, as in CI.
 */

import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { crawlScriptSource, linkHarvestSource, type CrawlPageExtract } from './crawl-page-script';

function executable(): string | null {
  const candidates = [
    process.env.SANDBOX_BROWSER_EXECUTABLE,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // No install of its own.
  }
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null;
}

const exe = executable();

/** Shaped like a Caristix segment page: chrome around a <main> with a field table. */
const SEGMENT_PAGE = `<!doctype html><html><head><title>AIG - Segment (HL7 v2.3)</title>
<style>.detail{display:none}</style></head><body>
<header><a href="/console">Caristix Apps Home Page</a> Rotating banner text</header>
<nav><a href="/v2/HL7v2.3/Segments">HL7 v2.3 - Segments</a></nav>
<main>
  <button><i class="material-icons">arrow_back_ios</i></button>
  <h2>HL7 v2.3 - AIG - Appointment Information - General Resource</h2>
  <p>The AIG segment contains information about various kinds of resources.</p>
  <table>
    <thead><tr><th>FIELD</th><th>LENGTH</th><th>DATA TYPE</th><th>OPTIONALITY</th><th></th></tr></thead>
    <tbody>
      <tr><td><a href="/v2/HL7v2.3/Fields/AIG.1">AIG.1 - Set ID - AIG</a></td><td>4</td><td>SI</td><td>R</td><td><span class="material-icons">expand_more</span></td></tr>
      <tr class="detail"><td colspan="5">Hidden detail row</td></tr>
      <tr><td><a href="/v2/HL7v2.3/Fields/AIG.2">AIG.2 - Segment Action Code</a></td><td>3</td><td>ID</td><td>C</td><td><span class="material-icons">expand_more</span></td></tr>
    </tbody>
  </table>
  <a href="/v2/HL7v2.3/Segments/AIL#top">Next: AIL</a>
</main>
<footer>Copyright © Caristix</footer>
<div role="dialog">We use cookies…</div>
</body></html>`;

(exe ? describe : describe.skip)('the crawl extract in Chromium', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: exe!,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function extract(
    html: string,
    region: 'auto' | 'main' | 'page' = 'auto'
  ): Promise<CrawlPageExtract> {
    const page = await browser.newPage();
    try {
      await page.route('https://crawl.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: html })
      );
      await page.goto('https://crawl.test/v2/HL7v2.3/Segments/AIG');
      return await page.evaluate<CrawlPageExtract>(
        crawlScriptSource({ region, maxTextChars: 10_000, maxTables: 5, maxRows: 100 })
      );
    } finally {
      await page.close();
    }
  }

  it('keeps the main region and turns the field table into rows', async () => {
    const page = await extract(SEGMENT_PAGE);
    expect(page.title).toBe('AIG - Segment (HL7 v2.3)');
    expect(page.region).toBe('main');
    expect(page.text).toContain('The AIG segment contains information');
    // Chrome outside <main>, and the table (kept as rows), are not in the text.
    expect(page.text).not.toContain('Rotating banner');
    expect(page.text).not.toContain('cookies');
    expect(page.text).not.toContain('AIG.1');
    expect(page.text).not.toContain('arrow_back_ios');
    expect(page.tables).toEqual([
      {
        headers: ['FIELD', 'LENGTH', 'DATA TYPE', 'OPTIONALITY'],
        rows: [
          ['AIG.1 - Set ID - AIG', '4', 'SI', 'R'],
          ['AIG.2 - Segment Action Code', '3', 'ID', 'C'],
        ],
      },
    ]);
    expect(page.links).toContain('https://crawl.test/v2/HL7v2.3/Segments/AIL#top');
    expect(page.links).toContain('https://crawl.test/console');
  });

  it('harvests every row of a virtual list by scrolling its container', async () => {
    // 300 rows, 30px each, in a 300px box: only the rows in view exist.
    const html = `<html><body><main><div id="box" style="height:300px;overflow-y:auto">
      <div id="inner" style="position:relative;height:9000px"></div></div></main>
      <script>
        const box = document.getElementById('box');
        const inner = document.getElementById('inner');
        function render() {
          const first = Math.floor(box.scrollTop / 30);
          inner.innerHTML = '';
          for (let i = first; i < Math.min(300, first + 12); i++) {
            const a = document.createElement('a');
            a.href = '/Segments/S' + i;
            a.textContent = 'S' + i;
            a.style.cssText = 'position:absolute;top:' + i * 30 + 'px';
            inner.appendChild(a);
          }
        }
        box.addEventListener('scroll', render);
        render();
      </script></body></html>`;
    const page = await browser.newPage();
    try {
      await page.route('https://crawl.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: html })
      );
      await page.goto('https://crawl.test/Segments');
      const links = await page.evaluate<string[]>(
        linkHarvestSource({ maxSteps: 200, stepWaitMs: 20, maxMs: 20_000, maxLinks: 1_000 })
      );
      const segments = links.filter((link) => link.includes('/Segments/S'));
      expect(segments).toHaveLength(300);
      expect(segments).toContain('https://crawl.test/Segments/S299');
    } finally {
      await page.close();
    }
  });

  it('reads the whole page when asked, and bounds the text', async () => {
    const page = await extract(SEGMENT_PAGE, 'page');
    expect(page.region).toBe('page');
    expect(page.text).toContain('Rotating banner');
    const long = await extract(
      `<html><body><main><p>${'word '.repeat(5000)}</p></main></body></html>`
    );
    expect(long.text.length).toBe(10_000);
    expect(long.textTruncated).toBe(true);
  });
});

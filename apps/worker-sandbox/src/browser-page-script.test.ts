/**
 * The in-page walk, run in a real Chromium when one is at hand (the
 * SANDBOX_BROWSER_EXECUTABLE the image pins, this environment's pinned
 * build, or playwright-core's own install): what a long job description
 * reads as is the one thing a scripted DOM cannot answer, since the walk
 * hangs on innerText and layout. Skipped — not failed — where no browser
 * is installed, as in CI.
 */

import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { pageScriptSource, type PageWalkResult } from './browser-page-script';
import { BROWSER_SNAPSHOT_MAX_NODES } from '@renkei/connector-sandbox';

function executable(): string | null {
  const candidates = [
    process.env.SANDBOX_BROWSER_EXECUTABLE,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // No install of its own; the pinned paths above may still be there.
  }
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null;
}

const exe = executable();

(exe ? describe : describe.skip)('the page walk in Chromium', () => {
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

  async function walk(
    html: string,
    maxNodes = BROWSER_SNAPSHOT_MAX_NODES
  ): Promise<PageWalkResult> {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
      return await page.evaluate<PageWalkResult>(pageScriptSource(maxNodes));
    } finally {
      await page.close();
    }
  }

  const textOf = (walked: PageWalkResult) =>
    walked.nodes.filter((node) => node.role === 'text').map((node) => node.name);

  it('reads a long description whole — a line per paragraph and bullet, nothing cut short', async () => {
    const sentence =
      'Manages the daily operations of ambulatory care services throughout the continuum. ';
    // Longer than one snapshot line may be, with no block break inside.
    const paragraph = sentence.repeat(20);
    const bullets = Array.from(
      { length: 5 },
      (_, i) => `<li>Duty ${i + 1}: ${sentence.trim()}</li>`
    ).join('');
    const walked = await walk(
      `<h2>Description</h2><div><p>${paragraph}</p><ul>${bullets}</ul><p>Status: full time.</p></div>`
    );
    expect(walked.truncated).toBe(false);
    const text = textOf(walked);
    // The paragraph continues across lines, cut at a word, so joining the
    // lines back with a space gives it back exactly.
    expect(text.join(' ')).toContain(paragraph.trim());
    expect(text.every((line) => line.length <= 1000)).toBe(true);
    expect(text.some((line) => line.endsWith('…'))).toBe(false);
    expect(text).toEqual(
      expect.arrayContaining([
        `Duty 1: ${sentence.trim()}`,
        `Duty 5: ${sentence.trim()}`,
        'Status: full time.',
      ])
    );
  }, 30_000);

  it('breaks lines where the page does, and only there', async () => {
    const walked = await walk(
      `<div>1520 Stockton Street<br>San Francisco, CA</div>` +
        `<div>Bachelor's degree\npreferred. <a href="https://example.com/x">Benefits</a> and more.</div>`
    );
    expect(
      walked.nodes.map((node) => (node.role === 'link' ? `[${node.name}]` : node.name))
    ).toEqual([
      '1520 Stockton Street',
      'San Francisco, CA',
      "Bachelor's degree preferred. and more.",
      '[Benefits]',
    ]);
  }, 30_000);

  it('still stops at the node ceiling and says so', async () => {
    const walked = await walk(`<div>${'<p>line</p>'.repeat(10)}</div>`, 3);
    expect(walked.truncated).toBe(true);
    expect(walked.nodes).toHaveLength(3);
  }, 30_000);
});

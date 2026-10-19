/**
 * What `sandbox_browser_crawl` keeps of one page — run INSIDE the browser
 * via `page.evaluate`, so (like browser-page-script.ts) it is one
 * self-contained function with every helper nested, shipped by source.
 *
 * Three things, each bounded:
 *  - `text`: the page as a person reads it, from its `<main>` landmark
 *    when the region says so (or, on 'auto', when there is exactly one
 *    with real text in it) — the header, nav, footer and cookie banner a
 *    snapshot repeats on every page are left out. Tables are taken out of
 *    the text, because…
 *  - `tables`: every visible table as rows of cell text under its header
 *    cells. Rows a person cannot see (a collapsed "expand" detail row) are
 *    skipped, and so is icon-font text ("expand_more") and anything
 *    aria-hidden, so a field table reads as its fields.
 *  - `links`: every link's absolute URL, for the crawler to follow the
 *    ones its recipe allows (the scope check happens in the worker, never
 *    here).
 */

export interface CrawledTable {
  headers: string[];
  rows: string[][];
}

export interface CrawlPageExtract {
  title: string;
  /** 'main' when the text came from the page's <main> landmark. */
  region: 'main' | 'page';
  text: string;
  textTruncated: boolean;
  tables: CrawledTable[];
  links: string[];
}

export interface CrawlExtractLimits {
  region: 'auto' | 'main' | 'page';
  maxTextChars: number;
  maxTables: number;
  maxRows: number;
}

/** The extract as an expression for `page.evaluate(string)` — see pageScriptSource for why. */
export function crawlScriptSource(limits: CrawlExtractLimits): string {
  return `(() => { const __name = (fn) => fn; return (${extractCrawlPageInPage.toString()})(${JSON.stringify(limits)}); })()`;
}

export function extractCrawlPageInPage(limits: CrawlExtractLimits): CrawlPageExtract {
  const MAX_LINKS = 2000;
  const CELL_MAX = 2000;

  function hidden(element: Element): boolean {
    if (element.closest('[aria-hidden="true"], script, style, noscript, template')) return true;
    if (/(^|\s)material-(icons|symbols)/.test(element.getAttribute('class') ?? '')) return true;
    if (element instanceof HTMLElement && element.offsetParent === null) {
      // display:none (or a detached-looking subtree); a fixed element has no
      // offsetParent either, so fall back to its computed style.
      const style = getComputedStyle(element);
      if (style.position !== 'fixed' || style.display === 'none') return true;
    }
    return false;
  }

  /** Visible text of an element, skipping icon fonts and hidden parts. */
  function textOf(element: Element): string {
    const parts: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || hidden(parent)) continue;
      const value = node.textContent ?? '';
      if (value.trim()) parts.push(value);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, CELL_MAX);
  }

  const mains = [...document.querySelectorAll('main, [role="main"]')];
  const mainEl = mains.length === 1 ? mains[0] : null;
  const useMain =
    limits.region === 'main'
      ? mainEl !== null
      : limits.region === 'auto'
        ? mainEl !== null && (mainEl.textContent ?? '').trim().length >= 40
        : false;
  const root: Element = useMain && mainEl ? mainEl : document.body;

  const tables: CrawledTable[] = [];
  const tableEls = [...root.querySelectorAll('table')].filter(
    (table) => !hidden(table) && !table.parentElement?.closest('table')
  );
  for (const table of tableEls.slice(0, limits.maxTables)) {
    const rows = [...table.querySelectorAll('tr')].filter(
      (row) => row.closest('table') === table && !hidden(row)
    );
    let headers: string[] = [];
    const body: string[][] = [];
    for (const row of rows) {
      const cells = [...row.children].filter(
        (cell) => cell.tagName === 'TD' || cell.tagName === 'TH'
      );
      const values = cells.map(textOf);
      if (values.every((value) => value === '')) continue;
      const isHeader =
        headers.length === 0 &&
        body.length === 0 &&
        (row.closest('thead') !== null || cells.every((cell) => cell.tagName === 'TH'));
      if (isHeader) headers = values;
      else if (body.length < limits.maxRows) body.push(values);
    }
    // Trailing empty columns (an icon-only "expand" column) carry nothing.
    let width = Math.max(headers.length, ...body.map((row) => row.length), 0);
    while (
      width > 0 &&
      (headers[width - 1] ?? '') === '' &&
      body.every((row) => (row[width - 1] ?? '') === '')
    ) {
      width -= 1;
    }
    tables.push({
      headers: headers.slice(0, width),
      rows: body.map((row) => row.slice(0, width)),
    });
  }

  // The text without the tables (they are kept as rows) or icon-font and
  // aria-hidden parts, read as laid out.
  const restore: [HTMLElement, string][] = [];
  const quiet = [
    ...tableEls,
    ...root.querySelectorAll(
      '[aria-hidden="true"], [class*="material-icons"], [class*="material-symbols"]'
    ),
  ];
  for (const element of quiet) {
    if (element instanceof HTMLElement) {
      restore.push([element, element.style.display]);
      element.style.display = 'none';
    }
  }
  const raw = root instanceof HTMLElement ? root.innerText : (root.textContent ?? '');
  for (const [element, display] of restore) element.style.display = display;
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
  const joined = lines.join('\n').trim();

  const links: string[] = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (links.length >= MAX_LINKS) break;
    if (!(anchor instanceof HTMLAnchorElement)) continue;
    const href = anchor.href;
    if (href && !links.includes(href)) links.push(href);
  }

  return {
    title: document.title,
    region: useMain ? 'main' : 'page',
    text: joined.slice(0, limits.maxTextChars),
    textTruncated: joined.length > limits.maxTextChars,
    tables,
    links,
  };
}

export interface LinkHarvestLimits {
  /** Scroll steps across all scrollers, in total. */
  maxSteps: number;
  /** The pause after each step, for a lazy list to render. */
  stepWaitMs: number;
  /** Wall-clock bound on the whole harvest. */
  maxMs: number;
  maxLinks: number;
}

/** The harvest as an expression for `page.evaluate(string)` — it resolves to the links found. */
export function linkHarvestSource(limits: LinkHarvestLimits): string {
  return `(() => { const __name = (fn) => fn; return (${harvestLinksInPage.toString()})(${JSON.stringify(limits)}); })()`;
}

/**
 * Every link a page shows while it is scrolled through, a screen at a
 * time — for a page whose links the crawler follows. A virtual list (an
 * index of hundreds of entries) renders only the rows in view and drops
 * the rest, so its links exist only as it scrolls: each step collects
 * what is rendered, then moves every scrollable area (the page itself
 * and any overflow container) on by most of its height, until all are
 * at their end or a bound is reached.
 */
export async function harvestLinksInPage(limits: LinkHarvestLimits): Promise<string[]> {
  const found = new Set<string>();
  const collect = () => {
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (found.size >= limits.maxLinks) return;
      if (anchor instanceof HTMLAnchorElement && anchor.href) found.add(anchor.href);
    }
  };
  const scrollers = (): Element[] => {
    const list: Element[] = [document.scrollingElement ?? document.documentElement];
    for (const element of document.querySelectorAll('*')) {
      if (element.scrollHeight <= element.clientHeight + 10) continue;
      const overflow = getComputedStyle(element).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') list.push(element);
    }
    return list;
  };
  const started = Date.now();
  collect();
  for (let step = 0; step < limits.maxSteps; step += 1) {
    if (Date.now() - started > limits.maxMs || found.size >= limits.maxLinks) break;
    let moved = false;
    for (const element of scrollers()) {
      const before = element.scrollTop;
      element.scrollTop = before + Math.max(200, Math.floor(element.clientHeight * 0.8));
      if (element.scrollTop > before) moved = true;
    }
    if (!moved) break;
    await new Promise((resolve) => setTimeout(resolve, limits.stepWaitMs));
    collect();
  }
  return [...found];
}

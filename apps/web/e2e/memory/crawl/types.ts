import type { TableRows } from '@renkei/db';

/**
 * One page the crawl visits (../crawl.spec.ts). A page with a dynamic
 * segment names the row it shows and seeds it; `expectText` is something
 * only the seeded data can put on screen, so a page that rendered without
 * reading its rows fails even if it reached for nothing.
 */
export interface CrawlPage {
  /** The URL, ids filled in. */
  path: string;
  /** Rows the page needs, given the crawl's signed-in person (and their session, for rows bound to it). */
  seed?: (subject: string, sessionId: string) => TableRows;
  /** Visible once the page rendered its data. */
  expectText?: string | RegExp;
}

/** Deterministic ids for crawl fixtures: `crawlId(3)` → 00000000-0000-4000-8000-c0000000003 style. */
export function crawlId(n: number): string {
  return `00000000-0000-4000-8000-c${String(n).padStart(11, '0')}`;
}

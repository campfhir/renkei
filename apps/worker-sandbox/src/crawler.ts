/**
 * The crawl loop behind `sandbox_browser_crawl`.
 *
 * A crawl starts with one call and runs here in the background: a page
 * at a time, in a browser context of its own (never the caller's
 * interactive session, whose page and refs it would trample), at most
 * CRAWL_CONCURRENCY crawls at once across the worker. The call that
 * started it returns at once; the sandbox_crawl_* read tools report
 * progress and hand the pages back.
 *
 * Scope is the recipe's and nothing else (crawl.ts): a seed was named in
 * the approved call; a link found on a page is queued only when it is on
 * the recipe's origin and matches its pattern, and only while `follow`
 * allows that depth. Every URL also goes through the egress guard before
 * it is loaded, and a page that redirects off the origin is recorded as
 * failed and read no further — so a page cannot steer the crawler, or
 * the data it carries, anywhere the approval did not cover.
 *
 * Progress is written after every page (the queue left, the counts), so
 * a crawl stopped by its page budget, a stop request, or a worker
 * restart resumes from exactly where it was.
 */

import {
  CRAWL_MAX_PAGES,
  CRAWL_MAX_TABLES,
  CRAWL_MAX_TABLE_ROWS,
  CRAWL_PAGE_DELAY_MS,
  CRAWL_PAGE_TEXT_MAX_CHARS,
  inCrawlScope,
  normalizeCrawlUrl,
  type CrawlRecipe,
} from '@renkei/connector-sandbox';
import {
  CRAWL_EXTRACT_SOURCE,
  LINK_HARVEST_SOURCE,
  type CrawlExtractLimits,
  type CrawlPageExtract,
  type LinkHarvestLimits,
} from './crawl-page-script';
import type { CrawlRow, CrawlStore, CrawlTarget, PageSummary, QueuedPage } from './crawl-store';
import { logger } from './logger';

/** Crawls running at once across this worker. */
export const CRAWL_CONCURRENCY = 2;
/** How long a crawl and its pages are kept. */
export const CRAWL_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** A crawl not heard from in this long was left behind by a worker that stopped. */
export const CRAWL_STALE_MS = 5 * 60_000;
/** One page's load, and the quiet after it. */
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const PAGE_SETTLE_TIMEOUT_MS = 5_000;
/**
 * A page whose links are followed is scrolled through first, collecting
 * links at every step (crawl-page-script.ts, harvestLinksInPage): a long
 * index in a virtual list (the HL7 segment list) renders only the rows in
 * view. Bounded in steps and time.
 */
const LINK_HARVEST: LinkHarvestLimits = {
  maxSteps: 120,
  stepWaitMs: 300,
  maxMs: 45_000,
  maxLinks: 5_000,
};

/** The slice of a Playwright page the crawler uses — the test seam. */
export interface CrawlPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>;
  url(): string;
  /**
   * Run `source` — an expression that evaluates to a function — in the
   * page, calling it with `arg`. The argument travels as data, never
   * written into the source.
   */
  call<T>(source: string, arg: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface CrawlContext {
  newPage(): Promise<CrawlPage>;
  close(): Promise<void>;
}

export interface CrawlerDeps {
  store: CrawlStore;
  /** A fresh browser context, through the worker's egress proxy. */
  openContext: () => Promise<CrawlContext>;
  /** Throws when a URL may not be loaded (assertPublicHttpsUrl). */
  guard: (url: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
  concurrency?: number;
}

export class CrawlError extends Error {
  constructor(
    readonly type: 'not_found' | 'busy' | 'bad_request',
    message: string
  ) {
    super(message);
    this.name = 'CrawlError';
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 300);
}

export class Crawler {
  private readonly store: CrawlStore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly delayMs: number;
  private readonly concurrency: number;
  /** Crawl ids running in this process. */
  private readonly running = new Set<string>();
  /** Crawl ids waiting for a slot, in order. */
  private readonly waiting: string[] = [];

  constructor(private readonly deps: CrawlerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.delayMs = deps.delayMs ?? CRAWL_PAGE_DELAY_MS;
    this.concurrency = deps.concurrency ?? CRAWL_CONCURRENCY;
  }

  /** Start a crawl of `seeds` under `recipe`; it runs in the background. */
  async start(
    target: CrawlTarget,
    input: {
      recipe: CrawlRecipe;
      seeds: string[];
      recipeName: string | null;
      /** What to save under `recipeName`, when not `recipe` itself (a one-off budget is not saved). */
      saveRecipe?: CrawlRecipe;
    }
  ): Promise<CrawlRow> {
    const crawl = await this.store.create({
      target,
      recipe: input.recipe,
      recipeName: input.recipeName,
      queue: input.seeds.map((url) => ({ url, depth: 0 })),
      expiresAt: new Date(this.now() + CRAWL_RETENTION_MS),
    });
    if (input.recipeName) {
      await this.store.saveRecipe(
        target,
        input.recipeName,
        input.saveRecipe ?? input.recipe,
        crawl.id
      );
    }
    this.enqueue(crawl.id);
    return crawl;
  }

  /**
   * Carry a stopped crawl on: the pages it has stay, the queue it left is
   * worked, and `extraPages` more may be read — by default enough for its
   * queue, or its own page budget if that is more.
   */
  async resume(target: CrawlTarget, crawlId: string, extraPages?: number): Promise<CrawlRow> {
    const crawl = await this.store.get(target, crawlId);
    if (!crawl) throw new CrawlError('not_found', 'No such crawl.');
    if (crawl.status === 'queued' || crawl.status === 'running') {
      throw new CrawlError('busy', 'That crawl is still running.');
    }
    if (crawl.queue.length === 0) {
      throw new CrawlError('bad_request', 'That crawl has no pages left to visit.');
    }
    const read = crawl.pagesDone + crawl.pagesFailed;
    // Unsaid, enough for what is queued (a followed crawl finds more as it
    // goes, so at least its own budget again).
    const more = Math.max(
      1,
      Math.min(CRAWL_MAX_PAGES, extraPages ?? Math.max(crawl.queue.length, crawl.recipe.maxPages))
    );
    await this.store.extend(crawl.id, { ...crawl.recipe, maxPages: read + more });
    this.enqueue(crawl.id);
    return (await this.store.get(target, crawlId)) ?? crawl;
  }

  /** Ask a crawl to stop after the page it is on; false when it was not running. */
  async stop(target: CrawlTarget, crawlId: string): Promise<boolean> {
    const crawl = await this.store.get(target, crawlId);
    if (!crawl) throw new CrawlError('not_found', 'No such crawl.');
    return this.store.transition(
      crawl.id,
      ['queued', 'running'],
      'stopped',
      'Stopped on request. Resume it to carry on.'
    );
  }

  /** Crawls this process holds (running or waiting for a slot). */
  activeCount(): number {
    return this.running.size + this.waiting.length;
  }

  private enqueue(crawlId: string): void {
    if (!this.waiting.includes(crawlId) && !this.running.has(crawlId)) this.waiting.push(crawlId);
    this.drain();
  }

  private drain(): void {
    while (this.running.size < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.running.add(next);
      void this.run(next)
        .catch((error: unknown) => {
          logger.error('crawl {crawlId} failed: {error}', {
            component: 'worker-sandbox/crawler',
            crawlId: next,
            error: firstLine(error),
          });
          return this.store.transition(next, ['queued', 'running'], 'failed', firstLine(error));
        })
        .finally(() => {
          this.running.delete(next);
          this.drain();
        });
    }
  }

  /** Test seam: resolves when nothing is running or waiting. */
  async idle(): Promise<void> {
    while (this.activeCount() > 0) await new Promise((resolve) => setImmediate(resolve));
  }

  private async run(crawlId: string): Promise<void> {
    if (!(await this.store.transition(crawlId, ['queued'], 'running'))) return;
    const crawl = await this.store.getById(crawlId);
    if (!crawl) return;
    const { recipe } = crawl;
    const visited = await this.store.visited(crawlId);
    const queue: QueuedPage[] = crawl.queue.filter((entry) => !visited.has(entry.url));
    const queued = new Set(queue.map((entry) => entry.url));
    let done = crawl.pagesDone;
    let failed = crawl.pagesFailed;

    const context = await this.deps.openContext();
    try {
      const page = await context.newPage();
      while (queue.length > 0) {
        if (done + failed >= recipe.maxPages) {
          await this.store.transition(
            crawlId,
            ['running'],
            'stopped',
            `Reached its page budget (${recipe.maxPages}) with ${queue.length} page(s) left. Resume it to carry on.`
          );
          return;
        }
        // A stop request lands between pages.
        const live = await this.store.getById(crawlId);
        if (!live || live.status !== 'running') return;

        const next = queue.shift()!;
        const summary: PageSummary = {
          url: next.url,
          seq: done + failed + 1,
          depth: next.depth,
          status: 'ok',
          title: null,
          textChars: 0,
          tableCount: 0,
          error: null,
        };
        const followsLinks = recipe.follow !== undefined && next.depth < recipe.follow.depth;
        const found = await this.readPage(page, next.url, recipe, followsLinks);
        if (found.ok) {
          const { extract } = found;
          summary.title = extract.title;
          summary.textChars = extract.text.length;
          summary.tableCount = extract.tables.length;
          await this.store.putPage(
            crawlId,
            summary,
            {
              title: extract.title,
              region: extract.region,
              text: extract.text,
              textTruncated: extract.textTruncated,
              tables: extract.tables,
            },
            crawl.subject
          );
          done += 1;
          if (recipe.follow && next.depth < recipe.follow.depth) {
            for (const link of extract.links) {
              const url = normalizeCrawlUrl(link);
              if (!url || visited.has(url) || queued.has(url) || !inCrawlScope(url, recipe))
                continue;
              queued.add(url);
              queue.push({ url, depth: next.depth + 1 });
            }
          }
        } else {
          summary.status = 'failed';
          summary.error = found.error;
          await this.store.putPage(crawlId, summary, null, crawl.subject);
          failed += 1;
        }
        visited.add(next.url);
        await this.store.progress(crawlId, { queue, done, failed });
        if (queue.length > 0) await this.sleep(this.delayMs);
      }
      await this.store.transition(crawlId, ['running'], 'completed', null);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async readPage(
    page: CrawlPage,
    url: string,
    recipe: CrawlRecipe,
    scrollToEnd: boolean
  ): Promise<{ ok: true; extract: CrawlPageExtract } | { ok: false; error: string }> {
    try {
      await this.deps.guard(url);
    } catch (error) {
      return { ok: false, error: `Refused: ${firstLine(error)}` };
    }
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
    } catch (error) {
      return { ok: false, error: `Could not load the page: ${firstLine(error)}` };
    }
    // A JavaScript-rendered page fills in after the document loads.
    await page.waitForLoadState('networkidle', { timeout: PAGE_SETTLE_TIMEOUT_MS }).catch(() => {});
    let landed: URL | null = null;
    try {
      landed = new URL(page.url());
    } catch {
      // Not a URL (an error page): handled below.
    }
    if (!landed || landed.origin !== recipe.origin) {
      return {
        ok: false,
        error: `The page went to ${landed ? landed.origin : 'an error page'}, outside ${recipe.origin}; not read.`,
      };
    }
    // Collected before the extract, which then reads the page as the
    // harvest left it; its own links are added to these.
    const harvested = scrollToEnd
      ? await page.call<string[]>(LINK_HARVEST_SOURCE, LINK_HARVEST).catch((): string[] => [])
      : [];
    try {
      const extract = await page.call<CrawlPageExtract>(CRAWL_EXTRACT_SOURCE, {
        // Only the three regions the page script knows, whatever a stored recipe says.
        region: recipe.region === 'main' || recipe.region === 'page' ? recipe.region : 'auto',
        maxTextChars: CRAWL_PAGE_TEXT_MAX_CHARS,
        maxTables: CRAWL_MAX_TABLES,
        maxRows: CRAWL_MAX_TABLE_ROWS,
      } satisfies CrawlExtractLimits);
      const links = [...new Set([...harvested, ...extract.links])];
      return { ok: true, extract: { ...extract, links } };
    } catch (error) {
      return { ok: false, error: `Could not read the page: ${firstLine(error)}` };
    }
  }
}

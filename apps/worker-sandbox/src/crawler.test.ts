import { planCrawl, type CrawlRecipe } from '@renkei/connector-sandbox';
import { Crawler, type CrawlContext, type CrawlPage } from './crawler';
import type { CrawlPageExtract } from './crawl-page-script';
import { memoryCrawlStore } from './test-support/memory-crawl-store';

const ORIGIN = 'https://hl7.example';
const ME = { subject: 'person-1' };

/** A site: each URL's title, links, and (optionally) where it redirects or whether it fails. */
interface FakeSite {
  [url: string]: {
    links?: string[];
    /** Links the page only shows once it has been scrolled to its end. */
    moreOnScroll?: string[];
    redirect?: string;
    fail?: boolean;
    table?: string[][];
  };
}

function fakeBrowser(site: FakeSite) {
  const loaded: string[] = [];
  let contexts = 0;
  let closed = 0;
  const openContext = async (): Promise<CrawlContext> => {
    contexts += 1;
    let current = 'about:blank';
    let scrolls = 0;
    const page: CrawlPage = {
      async goto(url) {
        loaded.push(url);
        const entry = site[url];
        if (!entry || entry.fail) throw new Error(`net::ERR_FAILED at ${url}`);
        current = entry.redirect ?? url;
        scrolls = 0;
      },
      async waitForLoadState() {},
      url: () => current,
      async call<T>(source: string): Promise<T> {
        const entry = site[current] ?? {};
        if (source.includes('harvestLinksInPage')) {
          // Scrolled through: what the page shows only on the way down.
          scrolls += 1;
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return [...(entry.links ?? []), ...(entry.moreOnScroll ?? [])] as T;
        }
        const extract: CrawlPageExtract = {
          title: `Title of ${current}`,
          region: 'main',
          text: `Text of ${current}`,
          textTruncated: false,
          tables: entry.table
            ? [{ headers: ['Field', 'Length'], rows: entry.table.map((r) => r) }]
            : [],
          // A virtual list: at the end of a scroll, the early rows are gone.
          links: scrolls > 0 ? (entry.moreOnScroll ?? []) : (entry.links ?? []),
        };
        // The extract is the page's; the generic is the caller's to trust.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        return extract as T;
      },
      async close() {},
    };
    return {
      async newPage() {
        return page;
      },
      async close() {
        closed += 1;
      },
    };
  };
  return { openContext, loaded, contexts: () => contexts, closed: () => closed };
}

function plan(input: Record<string, unknown>): { recipe: CrawlRecipe; seeds: string[] } {
  const planned = planCrawl({ origin: ORIGIN, ...input });
  if (!planned.ok) throw new Error(planned.error);
  return { recipe: planned.recipe, seeds: planned.seeds };
}

function crawlerFor(site: FakeSite, guard: (url: string) => Promise<void> = async () => {}) {
  const store = memoryCrawlStore();
  const browser = fakeBrowser(site);
  const crawler = new Crawler({
    store,
    openContext: browser.openContext,
    guard,
    sleep: async () => {},
  });
  return { store, browser, crawler };
}

describe('Crawler', () => {
  it('reads every templated page in order and keeps their tables', async () => {
    const site: FakeSite = {
      [`${ORIGIN}/Segments/AIG`]: {
        table: [
          ['AIG.1', '4'],
          ['AIG.14', '200'],
        ],
      },
      [`${ORIGIN}/Segments/AIL`]: { table: [['AIL.1', '4']] },
    };
    const { store, browser, crawler } = crawlerFor(site);
    const started = await crawler.start(ME, {
      ...plan({
        pattern: '/Segments/*',
        template: { url: `${ORIGIN}/Segments/{value}`, values: ['AIG', 'AIL'] },
      }),
      recipeName: 'hl7 segments',
    });
    expect(started.status).toBe('queued');
    await crawler.idle();

    const crawl = await store.get(ME, started.id);
    expect(crawl?.status).toBe('completed');
    expect(crawl?.pagesDone).toBe(2);
    expect(crawl?.queue).toEqual([]);
    expect(browser.loaded).toEqual([`${ORIGIN}/Segments/AIG`, `${ORIGIN}/Segments/AIL`]);
    expect(browser.closed()).toBe(1);
    const pages = await store.pages(ME, started.id, { offset: 0, limit: 10, withContent: true });
    expect(pages.map((page) => [page.seq, page.url, page.tableCount])).toEqual([
      [1, `${ORIGIN}/Segments/AIG`, 1],
      [2, `${ORIGIN}/Segments/AIL`, 1],
    ]);
    expect(pages[0].content?.tables[0].rows).toEqual([
      ['AIG.1', '4'],
      ['AIG.14', '200'],
    ]);
    // Saved under its name, pointing at this crawl.
    expect((await store.recipe(ME, 'hl7 segments'))?.lastCrawlId).toBe(started.id);
    // Another person sees none of it.
    expect(await store.get({ subject: 'someone-else' }, started.id)).toBeNull();
  });

  it('follows only in-pattern links on the origin, to the allowed depth', async () => {
    const site: FakeSite = {
      [`${ORIGIN}/Segments`]: {
        links: [
          `${ORIGIN}/Segments/AIG#top`,
          `${ORIGIN}/Segments/AIL`,
          `${ORIGIN}/Segments/AIG`, // a duplicate once the fragment is gone
          `${ORIGIN}/Fields/AIG.1`, // outside the pattern
          'https://tracker.example/Segments/AIG?leak=secret', // off the origin
        ],
      },
      [`${ORIGIN}/Segments/AIG`]: { links: [`${ORIGIN}/Segments/PID`] },
      [`${ORIGIN}/Segments/AIL`]: {},
      [`${ORIGIN}/Segments/PID`]: {},
    };
    const { store, browser, crawler } = crawlerFor(site);
    const started = await crawler.start(ME, {
      ...plan({ pattern: '/Segments/*', follow: { from: [`${ORIGIN}/Segments`], depth: 1 } }),
      recipeName: null,
    });
    await crawler.idle();
    // Depth 1: the list page's links, not the links on those pages.
    expect(browser.loaded).toEqual([
      `${ORIGIN}/Segments`,
      `${ORIGIN}/Segments/AIG`,
      `${ORIGIN}/Segments/AIL`,
    ]);
    expect((await store.get(ME, started.id))?.status).toBe('completed');
  });

  it('scrolls a page whose links it follows to its end first', async () => {
    const site: FakeSite = {
      [`${ORIGIN}/Segments`]: {
        links: [`${ORIGIN}/Segments/ACC`],
        moreOnScroll: [`${ORIGIN}/Segments/UB2`],
      },
      [`${ORIGIN}/Segments/ACC`]: { moreOnScroll: [`${ORIGIN}/Segments/ZZZ`] },
      [`${ORIGIN}/Segments/UB2`]: {},
    };
    const { browser, crawler } = crawlerFor(site);
    await crawler.start(ME, {
      ...plan({ pattern: '/Segments/*', follow: { from: [`${ORIGIN}/Segments`], depth: 1 } }),
      recipeName: null,
    });
    await crawler.idle();
    // UB2 only showed after the scroll; ACC (depth 1) is not scrolled or followed.
    expect(browser.loaded).toEqual([
      `${ORIGIN}/Segments`,
      `${ORIGIN}/Segments/ACC`,
      `${ORIGIN}/Segments/UB2`,
    ]);
  });

  it('records refused, failed and off-origin pages as failed and carries on', async () => {
    const site: FakeSite = {
      [`${ORIGIN}/a`]: { redirect: 'https://elsewhere.example/landing' },
      [`${ORIGIN}/b`]: { fail: true },
      [`${ORIGIN}/c`]: {},
      [`${ORIGIN}/d`]: {},
    };
    const { store, browser, crawler } = crawlerFor(site, async (url) => {
      if (url.endsWith('/c')) throw new Error('resolves to a private address');
    });
    const started = await crawler.start(ME, {
      ...plan({ pattern: '/*', urls: ['a', 'b', 'c', 'd'].map((p) => `${ORIGIN}/${p}`) }),
      recipeName: null,
    });
    await crawler.idle();
    const crawl = await store.get(ME, started.id);
    expect(crawl?.status).toBe('completed');
    expect([crawl?.pagesDone, crawl?.pagesFailed]).toEqual([1, 3]);
    // The guard refused /c before any load.
    expect(browser.loaded).not.toContain(`${ORIGIN}/c`);
    const pages = await store.pages(ME, started.id, { offset: 0, limit: 10, withContent: true });
    expect(pages.map((page) => [page.status, page.error?.slice(0, 20) ?? null])).toEqual([
      ['failed', 'The page went to htt'],
      ['failed', 'Could not load the p'],
      ['failed', 'Refused: resolves to'],
      ['ok', null],
    ]);
    expect(pages[0].content).toBeNull();
  });

  it('stops at its page budget and resumes where it left off', async () => {
    const site: FakeSite = Object.fromEntries(
      ['1', '2', '3', '4', '5'].map((p) => [`${ORIGIN}/p/${p}`, {}])
    );
    const { store, browser, crawler } = crawlerFor(site);
    const started = await crawler.start(ME, {
      ...plan({
        pattern: '/p/*',
        urls: Object.keys(site),
        maxPages: 2,
      }),
      recipeName: null,
    });
    await crawler.idle();
    let crawl = await store.get(ME, started.id);
    expect(crawl?.status).toBe('stopped');
    expect(crawl?.error).toContain('page budget (2) with 3 page(s) left');
    expect(crawl?.queue.map((entry) => entry.url)).toEqual(Object.keys(site).slice(2));

    await crawler.resume(ME, started.id, 10);
    await crawler.idle();
    crawl = await store.get(ME, started.id);
    expect(crawl?.status).toBe('completed');
    expect(crawl?.pagesDone).toBe(5);
    // Nothing read twice.
    expect(browser.loaded).toEqual(Object.keys(site));
    await expect(crawler.resume(ME, started.id)).rejects.toThrow('no pages left');
  });

  it('stops between pages when asked', async () => {
    const site: FakeSite = { [`${ORIGIN}/x/1`]: {}, [`${ORIGIN}/x/2`]: {} };
    const { store } = crawlerFor(site);
    let stopNow: (() => Promise<unknown>) | null = null;
    // Stop as soon as the first page is in.
    const slow = new Crawler({
      store,
      openContext: fakeBrowser(site).openContext,
      guard: async () => {},
      sleep: async () => {
        await stopNow?.();
      },
    });
    const started = await slow.start(ME, {
      ...plan({ pattern: '/x/*', urls: Object.keys(site) }),
      recipeName: null,
    });
    stopNow = () => slow.stop(ME, started.id);
    await slow.idle();
    const crawl = await store.get(ME, started.id);
    expect(crawl?.status).toBe('stopped');
    expect(crawl?.pagesDone).toBe(1);
    expect(crawl?.queue).toHaveLength(1);
  });

  it('marks crawls a stopped worker left behind as resumable', async () => {
    const { store } = crawlerFor({});
    const crawl = await store.create({
      target: ME,
      recipe: plan({ pattern: '/*', urls: [`${ORIGIN}/a`] }).recipe,
      recipeName: null,
      queue: [{ url: `${ORIGIN}/a`, depth: 0 }],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.transition(crawl.id, ['queued'], 'running');
    expect(await store.releaseStale(new Date(Date.now() + 1_000))).toBe(1);
    expect((await store.get(ME, crawl.id))?.status).toBe('stopped');
  });
});

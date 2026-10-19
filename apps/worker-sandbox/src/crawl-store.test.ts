/**
 * The Postgres crawl store against a real database when DATABASE_URL is
 * set (skipped otherwise): content sealed at rest, every read scoped to
 * its subject, recipes upserted by name, and the sweeps.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { getDatabase, type DB } from '@renkei/db';
import type { Kysely } from 'kysely';
import type { CrawlRecipe } from '@renkei/connector-sandbox';
import { createCrawlStore, type CrawlStore } from './crawl-store';

const hasDb = Boolean(process.env.DATABASE_URL);

(hasDb ? describe : describe.skip)('crawl store (Postgres)', () => {
  let db: Kysely<DB>;
  let store: CrawlStore;
  const me = { subject: `crawl-test-${randomUUID()}` };
  const other = { subject: `crawl-test-${randomUUID()}` };
  const recipe: CrawlRecipe = {
    origin: 'https://hl7.example',
    pattern: '/Segments/*',
    urls: ['https://hl7.example/Segments/AIG'],
    region: 'auto',
    maxPages: 5,
  };

  beforeAll(() => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    store = createCrawlStore(db, randomBytes(32), 'test-domain');
  });

  afterAll(async () => {
    await db
      .deleteFrom('sandbox_crawl_recipes')
      .where('subject', 'in', [me.subject, other.subject])
      .execute();
    await db
      .deleteFrom('sandbox_crawls')
      .where('subject', 'in', [me.subject, other.subject])
      .execute();
  });

  it('seals page content, opens it for its subject only, and orders pages', async () => {
    const crawl = await store.create({
      target: me,
      recipe,
      recipeName: null,
      queue: [{ url: 'https://hl7.example/Segments/AIG', depth: 0 }],
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(crawl.status).toBe('queued');
    expect(crawl.queue).toEqual([{ url: 'https://hl7.example/Segments/AIG', depth: 0 }]);

    await store.putPage(
      crawl.id,
      {
        url: 'https://hl7.example/Segments/AIL',
        seq: 2,
        depth: 0,
        status: 'ok',
        title: 'AIL',
        textChars: 10,
        tableCount: 1,
        error: null,
      },
      {
        title: 'AIL',
        region: 'main',
        text: 'AIL segment',
        textTruncated: false,
        tables: [{ headers: ['Field'], rows: [['AIL.1 - Set ID']] }],
      },
      me.subject
    );
    await store.putPage(
      crawl.id,
      {
        url: 'https://hl7.example/Segments/AIG',
        seq: 1,
        depth: 0,
        status: 'failed',
        title: null,
        textChars: 0,
        tableCount: 0,
        error: 'Could not load the page',
      },
      null,
      me.subject
    );

    const stored = await db
      .selectFrom('sandbox_crawl_pages')
      .select('content')
      .where('crawl_id', '=', crawl.id)
      .where('url', '=', 'https://hl7.example/Segments/AIL')
      .executeTakeFirstOrThrow();
    expect(stored.content?.startsWith('crawl1.')).toBe(true);
    expect(stored.content).not.toContain('AIL.1');

    const pages = await store.pages(me, crawl.id, { offset: 0, limit: 10, withContent: true });
    expect(pages.map((page) => page.seq)).toEqual([1, 2]);
    expect(pages[1].content?.tables[0].rows).toEqual([['AIL.1 - Set ID']]);
    expect(pages[0].content).toBeNull();
    const listed = await store.pages(me, crawl.id, { offset: 0, limit: 10, withContent: false });
    expect(listed[1].content).toBeNull();
    expect(await store.pages(other, crawl.id, { offset: 0, limit: 10, withContent: true })).toEqual(
      []
    );
    expect(await store.get(other, crawl.id)).toBeNull();
    expect(await store.visited(crawl.id)).toEqual(
      new Set(['https://hl7.example/Segments/AIG', 'https://hl7.example/Segments/AIL'])
    );

    expect(await store.transition(crawl.id, ['queued'], 'running')).toBe(true);
    expect(await store.transition(crawl.id, ['queued'], 'running')).toBe(false);
    await store.progress(crawl.id, { queue: [], done: 1, failed: 1 });
    expect(await store.releaseStale(new Date(Date.now() + 60_000))).toBeGreaterThanOrEqual(1);
    const released = await store.get(me, crawl.id);
    expect(released?.status).toBe('stopped');
    expect([released?.pagesDone, released?.pagesFailed]).toEqual([1, 1]);
  });

  it('saves a recipe by name, replacing it on a second save', async () => {
    await store.saveRecipe(me, 'segments', recipe, null);
    await store.saveRecipe(me, 'segments', { ...recipe, maxPages: 9 }, null);
    expect((await store.recipe(me, 'segments'))?.recipe.maxPages).toBe(9);
    expect(await store.recipe(other, 'segments')).toBeNull();
    expect((await store.recipes(me)).map((row) => row.name)).toEqual(['segments']);
  });

  it('sweeps expired crawls with their pages', async () => {
    const crawl = await store.create({
      target: me,
      recipe,
      recipeName: null,
      queue: [],
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await store.sweepExpired(new Date())).toBeGreaterThanOrEqual(1);
    expect(await store.get(me, crawl.id)).toBeNull();
  });
});

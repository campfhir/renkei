import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const recipe = { origin: 'https://hl7.example', pattern: '/Segments/*', maxPages: 5 };

function crawl(
  n: number,
  subject: string,
  minute: number,
  status: string,
  options: { expires?: number; updated?: number } = {}
) {
  return {
    id: id(n),
    subject,
    recipe_name: n === 1 ? 'segments' : null,
    recipe: JSON.stringify(recipe),
    status,
    queue: JSON.stringify([{ url: `https://hl7.example/${n}`, depth: 0 }]),
    pages_done: n,
    pages_failed: 0,
    error: null,
    created_at: at(minute).toISOString(),
    updated_at: at(options.updated ?? minute).toISOString(),
    finished_at: null,
    expires_at: at(options.expires ?? 1000).toISOString(),
  };
}

function pageRow(crawlId: number, url: string, seq: number, content: string | null = null) {
  return {
    crawl_id: id(crawlId),
    url,
    seq,
    depth: 0,
    status: content ? 'ok' : 'failed',
    title: content ? `title ${url}` : null,
    content,
    text_chars: content ? content.length : 0,
    table_count: 0,
    error: content ? null : 'Could not load the page',
    fetched_at: at(seq).toISOString(),
  };
}

const fixture = {
  sandbox_crawls: [
    crawl(1, 'ann', 1, 'running', { updated: 5 }),
    crawl(2, 'ann', 3, 'queued', { updated: 20, expires: 50 }),
    crawl(3, 'ann', 3, 'completed', { expires: 40 }),
    crawl(4, 'bob', 4, 'queued', { updated: 2 }),
  ],
  sandbox_crawl_pages: [
    pageRow(1, 'https://hl7.example/b', 2, 'crawl1.b'),
    pageRow(1, 'https://hl7.example/a', 2),
    pageRow(1, 'https://hl7.example/c', 1, 'crawl1.c'),
    pageRow(4, 'https://hl7.example/z', 1, 'crawl1.z'),
  ],
  sandbox_crawl_recipes: [
    {
      subject: 'ann',
      name: 'segments',
      recipe: JSON.stringify(recipe),
      last_crawl_id: id(1),
      created_at: at(1).toISOString(),
      updated_at: at(6).toISOString(),
    },
    {
      subject: 'ann',
      name: 'Fields',
      recipe: JSON.stringify({ ...recipe, maxPages: 9 }),
      last_crawl_id: id(3),
      created_at: at(1).toISOString(),
      updated_at: at(6).toISOString(),
    },
    {
      subject: 'bob',
      name: 'segments',
      recipe: JSON.stringify(recipe),
      last_crawl_id: null,
      created_at: at(1).toISOString(),
      updated_at: at(9).toISOString(),
    },
  ],
};

export const sandboxCrawlScenarios: Scenario<DataStore>[] = [
  {
    method: 'sandboxCrawls.create',
    name: 'queued, JSON kept, read back by the subject only',
    fixture,
    run: async (store) => {
      const {
        createdAt: _c,
        updatedAt: _u,
        ...created
      } = await store.sandboxCrawls.create({
        id: id(9),
        subject: 'ann',
        recipeName: 'new',
        recipe: { ...recipe, urls: ['https://hl7.example/x'] },
        queue: [{ url: 'https://hl7.example/x', depth: 0 }],
        expiresAt: at(500),
      });
      return [
        created,
        await store.sandboxCrawls.get('bob', id(9)),
        (await store.sandboxCrawls.get('ann', id(9)))?.recipe,
      ];
    },
  },
  {
    method: 'sandboxCrawls.get',
    name: 'the subject’s own only',
    fixture,
    run: async (store) => [
      await store.sandboxCrawls.get('ann', id(1)),
      await store.sandboxCrawls.get('bob', id(1)),
      await store.sandboxCrawls.get('ann', id(99)),
    ],
  },
  {
    method: 'sandboxCrawls.getById',
    name: 'across subjects',
    fixture,
    run: async (store) => [
      await store.sandboxCrawls.getById(id(4)),
      await store.sandboxCrawls.getById(id(99)),
    ],
  },
  {
    method: 'sandboxCrawls.list',
    name: 'newest first, ties by id, bounded',
    fixture,
    run: async (store) => [
      (await store.sandboxCrawls.list('ann', 10)).map((c) => c.id),
      (await store.sandboxCrawls.list('ann', 2)).map((c) => c.id),
      await store.sandboxCrawls.list('nobody', 10),
    ],
  },
  {
    method: 'sandboxCrawls.transition',
    name: 'only from the states given',
    fixture,
    run: async (store) => [
      await store.sandboxCrawls.transition(id(2), ['queued'], 'running', {
        at: at(30),
        finishedAt: null,
      }),
      await store.sandboxCrawls.transition(id(2), ['queued'], 'running', {
        at: at(31),
        finishedAt: null,
      }),
      await store.sandboxCrawls.transition(id(1), ['running'], 'failed', {
        at: at(32),
        finishedAt: at(32),
        error: 'boom',
      }),
      await store.sandboxCrawls.transition(id(3), [], 'running', { at: at(33), finishedAt: null }),
      await store.sandboxCrawls.list('ann', 10),
    ],
  },
  {
    method: 'sandboxCrawls.progress',
    name: 'queue and counts after a page',
    fixture,
    run: async (store) => {
      await store.sandboxCrawls.progress(id(1), { queue: [], done: 7, failed: 2, at: at(40) });
      return store.sandboxCrawls.get('ann', id(1));
    },
  },
  {
    method: 'sandboxCrawls.extend',
    name: 'a new recipe, requeued, error cleared',
    fixture,
    run: async (store) => {
      await store.sandboxCrawls.transition(id(3), ['completed'], 'stopped', {
        at: at(41),
        finishedAt: at(41),
        error: 'stopped',
      });
      await store.sandboxCrawls.extend(id(3), { ...recipe, maxPages: 50 }, at(42));
      return store.sandboxCrawls.get('ann', id(3));
    },
  },
  {
    method: 'sandboxCrawls.putPage',
    name: 'a new URL inserts, a revisit replaces',
    fixture,
    run: async (store) => {
      await store.sandboxCrawls.putPage(
        id(1),
        {
          url: 'https://hl7.example/d',
          seq: 3,
          depth: 1,
          status: 'ok',
          title: 'D',
          content: 'crawl1.d',
          textChars: 4,
          tableCount: 1,
          error: null,
        },
        at(50)
      );
      await store.sandboxCrawls.putPage(
        id(1),
        {
          url: 'https://hl7.example/a',
          seq: 9,
          depth: 4,
          status: 'ok',
          title: 'A',
          content: 'crawl1.a',
          textChars: 8,
          tableCount: 2,
          error: null,
        },
        at(51)
      );
      return store.sandboxCrawls.pages('ann', id(1), { offset: 0, limit: 10 });
    },
  },
  {
    method: 'sandboxCrawls.visitedUrls',
    name: 'sorted, one crawl’s',
    fixture,
    run: async (store) => [
      await store.sandboxCrawls.visitedUrls(id(1)),
      await store.sandboxCrawls.visitedUrls(id(2)),
    ],
  },
  {
    method: 'sandboxCrawls.pages',
    name: 'by seq then url, paged, filtered, the subject’s crawl only',
    fixture,
    run: async (store) => [
      await store.sandboxCrawls.pages('ann', id(1), { offset: 0, limit: 10 }),
      await store.sandboxCrawls.pages('ann', id(1), { offset: 1, limit: 1 }),
      await store.sandboxCrawls.pages('ann', id(1), {
        urls: ['https://hl7.example/c', 'https://hl7.example/zz'],
        offset: 0,
        limit: 10,
      }),
      await store.sandboxCrawls.pages('ann', id(1), { urls: [], offset: 0, limit: 10 }),
      await store.sandboxCrawls.pages('bob', id(1), { offset: 0, limit: 10 }),
    ],
  },
  {
    method: 'sandboxCrawls.saveRecipe',
    name: 'a new name inserts, a held one replaces',
    fixture,
    run: async (store) => {
      await store.sandboxCrawls.saveRecipe(
        'ann',
        'segments',
        { ...recipe, maxPages: 2 },
        null,
        at(60)
      );
      await store.sandboxCrawls.saveRecipe('ann', 'new', recipe, id(2), at(61));
      return [await store.sandboxCrawls.recipes('ann'), await store.sandboxCrawls.recipes('bob')];
    },
  },
  {
    method: 'sandboxCrawls.recipe',
    name: 'by name, the subject’s own only',
    fixture,
    run: async (store) => [
      await store.sandboxCrawls.recipe('ann', 'Fields'),
      await store.sandboxCrawls.recipe('bob', 'Fields'),
    ],
  },
  {
    method: 'sandboxCrawls.recipes',
    name: 'most recently saved first, ties by name',
    fixture,
    run: async (store) => [
      await store.sandboxCrawls.recipes('ann'),
      await store.sandboxCrawls.recipes('nobody'),
    ],
  },
  {
    method: 'sandboxCrawls.releaseStale',
    name: 'queued or running, untouched since the cutoff',
    fixture,
    run: async (store) => [
      await store.sandboxCrawls.releaseStale(at(10), { error: 'interrupted', at: at(70) }),
      (await store.sandboxCrawls.list('ann', 10)).map((c) => [
        c.id,
        c.status,
        c.error,
        c.finishedAt,
      ]),
      (await store.sandboxCrawls.list('bob', 10)).map((c) => [c.id, c.status, c.finishedAt]),
    ],
  },
  {
    method: 'sandboxCrawls.sweepExpired',
    name: 'expired crawls go with their pages',
    fixture,
    run: async (store) => [
      await store.sandboxCrawls.sweepExpired(at(45)),
      (await store.sandboxCrawls.list('ann', 10)).map((c) => c.id),
      await store.sandboxCrawls.sweepExpired(at(1500)),
      await store.sandboxCrawls.visitedUrls(id(1)),
      await store.sandboxCrawls.recipes('ann'),
    ],
  },
];

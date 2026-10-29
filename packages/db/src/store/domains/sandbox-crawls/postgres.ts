import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import {
  crawlFromRow,
  crawlPageFromRow,
  crawlPagePatch,
  crawlPageValues,
  crawlRecipeFromRow,
  crawlValues,
  json,
} from './record';
import type { SandboxCrawlStore } from './types';

export function postgresSandboxCrawls(db: () => Kysely<DB>): SandboxCrawlStore {
  return {
    async create(crawl) {
      const row = await db()
        .insertInto('sandbox_crawls')
        .values(crawlValues(crawl))
        .returningAll()
        .executeTakeFirstOrThrow();
      return crawlFromRow(row);
    },
    async get(subject, id) {
      const row = await db()
        .selectFrom('sandbox_crawls')
        .selectAll()
        .where('id', '=', id)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row ? crawlFromRow(row) : null;
    },
    async getById(id) {
      const row = await db()
        .selectFrom('sandbox_crawls')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? crawlFromRow(row) : null;
    },
    async list(subject, limit) {
      const rows = await db()
        .selectFrom('sandbox_crawls')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(crawlFromRow);
    },
    async transition(id, from, to, change) {
      if (from.length === 0) return false;
      const result = await db()
        .updateTable('sandbox_crawls')
        .set({
          status: to,
          updated_at: change.at,
          finished_at: change.finishedAt,
          ...(change.error !== undefined ? { error: change.error } : {}),
        })
        .where('id', '=', id)
        .where('status', 'in', from)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
    async progress(id, update) {
      await db()
        .updateTable('sandbox_crawls')
        .set({
          queue: json(update.queue),
          pages_done: update.done,
          pages_failed: update.failed,
          updated_at: update.at,
        })
        .where('id', '=', id)
        .execute();
    },
    async extend(id, recipe, at) {
      await db()
        .updateTable('sandbox_crawls')
        .set({ recipe: json(recipe), status: 'queued', error: null, updated_at: at })
        .where('id', '=', id)
        .execute();
    },
    async putPage(crawlId, page, at) {
      await db()
        .insertInto('sandbox_crawl_pages')
        .values(crawlPageValues(crawlId, page, at))
        .onConflict((conflict) =>
          conflict.columns(['crawl_id', 'url']).doUpdateSet(crawlPagePatch(page, at))
        )
        .execute();
    },
    async visitedUrls(crawlId) {
      const rows = await db()
        .selectFrom('sandbox_crawl_pages')
        .select('url')
        .where('crawl_id', '=', crawlId)
        .orderBy('url')
        .execute();
      return rows.map((row) => row.url);
    },
    async pages(subject, crawlId, query) {
      // The crawl is the subject's, or nothing comes back.
      let select = db()
        .selectFrom('sandbox_crawl_pages as p')
        .innerJoin('sandbox_crawls as c', 'c.id', 'p.crawl_id')
        .select([
          'p.url',
          'p.seq',
          'p.depth',
          'p.status',
          'p.title',
          'p.text_chars',
          'p.table_count',
          'p.error',
          'p.content',
        ])
        .where('p.crawl_id', '=', crawlId)
        .where('c.subject', '=', subject);
      if (query.urls && query.urls.length > 0) select = select.where('p.url', 'in', query.urls);
      const rows = await select
        .orderBy('p.seq')
        .orderBy('p.url')
        .offset(query.offset)
        .limit(query.limit)
        .execute();
      return rows.map(crawlPageFromRow);
    },
    async saveRecipe(subject, name, recipe, crawlId, at) {
      await db()
        .insertInto('sandbox_crawl_recipes')
        .values({ subject, name, recipe: json(recipe), last_crawl_id: crawlId, updated_at: at })
        .onConflict((conflict) =>
          conflict.columns(['subject', 'name']).doUpdateSet({
            recipe: json(recipe),
            last_crawl_id: crawlId,
            updated_at: at,
          })
        )
        .execute();
    },
    async recipe(subject, name) {
      const row = await db()
        .selectFrom('sandbox_crawl_recipes')
        .selectAll()
        .where('subject', '=', subject)
        .where('name', '=', name)
        .executeTakeFirst();
      return row ? crawlRecipeFromRow(row) : null;
    },
    async recipes(subject) {
      const rows = await db()
        .selectFrom('sandbox_crawl_recipes')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('updated_at', 'desc')
        .orderBy('name')
        .execute();
      return rows.map(crawlRecipeFromRow);
    },
    async releaseStale(olderThan, change) {
      const result = await db()
        .updateTable('sandbox_crawls')
        .set({
          status: 'stopped',
          error: change.error,
          finished_at: change.at,
          updated_at: change.at,
        })
        .where('status', 'in', ['queued', 'running'])
        .where('updated_at', '<', olderThan)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async sweepExpired(now) {
      const result = await db()
        .deleteFrom('sandbox_crawls')
        .where('expires_at', '<', now)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}

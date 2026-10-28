import { orderBy, page } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import {
  crawlFromRow,
  crawlPageFromRow,
  crawlPagePatch,
  crawlPageValues,
  crawlRecipeFromRow,
  crawlValues,
} from './record';
import type { SandboxCrawlStore } from './types';

export function memorySandboxCrawls(tables: MemoryTables): SandboxCrawlStore {
  return {
    async create(crawl) {
      const now = new Date();
      return crawlFromRow(
        tables.insert('sandbox_crawls', {
          id: globalThis.crypto.randomUUID(),
          ...crawlValues(crawl),
          recipe: toJson(crawl.recipe),
          queue: toJson(crawl.queue),
          pages_done: 0,
          pages_failed: 0,
          error: null,
          finished_at: null,
          created_at: now,
          updated_at: now,
        })
      );
    },
    async get(subject, crawlId) {
      const wanted = crawlId;
      const row = tables.first('sandbox_crawls', (r) => r.id === wanted && r.subject === subject);
      return row ? crawlFromRow(row) : null;
    },
    async getById(crawlId) {
      const wanted = crawlId;
      const row = tables.first('sandbox_crawls', (r) => r.id === wanted);
      return row ? crawlFromRow(row) : null;
    },
    async list(subject, limit) {
      const rows = tables.select('sandbox_crawls', (r) => r.subject === subject);
      return page(orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]), limit).map(
        crawlFromRow
      );
    },
    async transition(crawlId, from, to, change) {
      const wanted = crawlId;
      const states = new Set(from);
      return (
        tables.update('sandbox_crawls', (r) => r.id === wanted && states.has(r.status), {
          status: to,
          updated_at: change.at,
          finished_at: change.finishedAt,
          ...(change.error !== undefined ? { error: change.error } : {}),
        }).length > 0
      );
    },
    async progress(crawlId, update) {
      const wanted = crawlId;
      tables.update('sandbox_crawls', (r) => r.id === wanted, {
        queue: toJson(update.queue),
        pages_done: update.done,
        pages_failed: update.failed,
        updated_at: update.at,
      });
    },
    async extend(crawlId, recipe, at) {
      const wanted = crawlId;
      tables.update('sandbox_crawls', (r) => r.id === wanted, {
        recipe: toJson(recipe),
        status: 'queued',
        error: null,
        updated_at: at,
      });
    },
    async putPage(crawlId, visited, at) {
      tables.upsert(
        'sandbox_crawl_pages',
        { ...crawlPageValues(crawlId, visited, at) },
        ['crawl_id', 'url'],
        crawlPagePatch(visited, at)
      );
    },
    async visitedUrls(crawlId) {
      const wanted = crawlId;
      const rows = tables.select('sandbox_crawl_pages', (r) => r.crawl_id === wanted);
      return orderBy(rows, [(r) => r.url]).map((row) => row.url);
    },
    async pages(subject, crawlId, query) {
      const wanted = crawlId;
      if (!tables.first('sandbox_crawls', (r) => r.id === wanted && r.subject === subject)) {
        return [];
      }
      const urls = query.urls && query.urls.length > 0 ? new Set(query.urls) : null;
      const rows = tables.select(
        'sandbox_crawl_pages',
        (r) => r.crawl_id === wanted && (!urls || urls.has(r.url))
      );
      return page(orderBy(rows, [(r) => r.seq], [(r) => r.url]), query.limit, query.offset).map(
        crawlPageFromRow
      );
    },
    async saveRecipe(subject, name, recipe, crawlId, at) {
      tables.upsert(
        'sandbox_crawl_recipes',
        {
          subject,
          name,
          recipe: toJson(recipe),
          last_crawl_id: crawlId,
          created_at: at,
          updated_at: at,
        },
        ['subject', 'name'],
        { recipe: toJson(recipe), last_crawl_id: crawlId, updated_at: at }
      );
    },
    async recipe(subject, name) {
      const row = tables.first(
        'sandbox_crawl_recipes',
        (r) => r.subject === subject && r.name === name
      );
      return row ? crawlRecipeFromRow(row) : null;
    },
    async recipes(subject) {
      const rows = tables.select('sandbox_crawl_recipes', (r) => r.subject === subject);
      return orderBy(rows, [(r) => r.updated_at, 'desc'], [(r) => r.name]).map(crawlRecipeFromRow);
    },
    async releaseStale(olderThan, change) {
      return tables.update(
        'sandbox_crawls',
        (r) =>
          (r.status === 'queued' || r.status === 'running') &&
          r.updated_at.getTime() < olderThan.getTime(),
        { status: 'stopped', error: change.error, finished_at: change.at, updated_at: change.at }
      ).length;
    },
    async sweepExpired(now) {
      const expired = tables.delete(
        'sandbox_crawls',
        (r) => r.expires_at.getTime() < now.getTime()
      );
      const ids = new Set(expired.map((r) => r.id));
      tables.delete('sandbox_crawl_pages', (r) => ids.has(r.crawl_id));
      tables.update(
        'sandbox_crawl_recipes',
        (r) => r.last_crawl_id !== null && ids.has(r.last_crawl_id),
        {
          last_crawl_id: null,
        }
      );
      return expired.length;
    },
  };
}

/** An in-memory CrawlStore for tests: the Postgres store's behaviour, minus Postgres. */

import { randomUUID } from 'node:crypto';
import type { CrawlRecipe } from '@renkei/connector-sandbox';
import type {
  CrawlRow,
  CrawlStore,
  PageContent,
  PageSummary,
  RecipeRow,
  StoredPage,
} from '../crawl-store';

export function memoryCrawlStore(): CrawlStore & {
  crawls: Map<string, CrawlRow & { expiresAt: Date }>;
  pageRows: Map<string, (PageSummary & { content: PageContent | null })[]>;
} {
  const crawls = new Map<string, CrawlRow & { expiresAt: Date }>();
  const pageRows = new Map<string, (PageSummary & { content: PageContent | null })[]>();
  const recipeRows = new Map<string, RecipeRow>();
  const copy = (row: CrawlRow): CrawlRow => ({ ...row, queue: [...row.queue] });
  return {
    crawls,
    pageRows,
    async create(input) {
      const now = new Date();
      const row = {
        id: randomUUID(),
        subject: input.target.subject,
        recipeName: input.recipeName,
        recipe: input.recipe,
        status: 'queued' as const,
        queue: [...input.queue],
        pagesDone: 0,
        pagesFailed: 0,
        error: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        expiresAt: input.expiresAt,
      };
      crawls.set(row.id, row);
      return copy(row);
    },
    async get(target, id) {
      const row = crawls.get(id);
      return row && row.subject === target.subject ? copy(row) : null;
    },
    async getById(id) {
      const row = crawls.get(id);
      return row ? copy(row) : null;
    },
    async list(target, limit) {
      return [...crawls.values()]
        .filter((row) => row.subject === target.subject)
        .reverse()
        .slice(0, limit)
        .map(copy);
    },
    async transition(id, from, to, error) {
      const row = crawls.get(id);
      if (!row || !from.includes(row.status)) return false;
      row.status = to;
      if (error !== undefined) row.error = error;
      row.finishedAt = ['completed', 'stopped', 'failed'].includes(to) ? new Date() : null;
      row.updatedAt = new Date();
      return true;
    },
    async progress(id, update) {
      const row = crawls.get(id);
      if (!row) return;
      row.queue = [...update.queue];
      row.pagesDone = update.done;
      row.pagesFailed = update.failed;
      row.updatedAt = new Date();
    },
    async extend(id, recipe: CrawlRecipe) {
      const row = crawls.get(id);
      if (!row) return;
      row.recipe = recipe;
      row.status = 'queued';
      row.error = null;
    },
    async putPage(crawlId, page, content) {
      const list = pageRows.get(crawlId) ?? [];
      const at = list.findIndex((existing) => existing.url === page.url);
      const entry = { ...page, content };
      if (at >= 0) list[at] = entry;
      else list.push(entry);
      pageRows.set(crawlId, list);
    },
    async visited(crawlId) {
      return new Set((pageRows.get(crawlId) ?? []).map((page) => page.url));
    },
    async pages(target, crawlId, query): Promise<StoredPage[]> {
      const crawl = crawls.get(crawlId);
      if (!crawl || crawl.subject !== target.subject) return [];
      return (pageRows.get(crawlId) ?? [])
        .filter((page) => !query.urls || query.urls.length === 0 || query.urls.includes(page.url))
        .sort((a, b) => a.seq - b.seq)
        .slice(query.offset, query.offset + query.limit)
        .map((page) => ({ ...page, content: query.withContent ? page.content : null }));
    },
    async saveRecipe(target, name, recipe, crawlId) {
      recipeRows.set(`${target.subject}\n${name}`, {
        name,
        recipe,
        lastCrawlId: crawlId,
        updatedAt: new Date(),
      });
    },
    async recipe(target, name) {
      return recipeRows.get(`${target.subject}\n${name}`) ?? null;
    },
    async recipes(target) {
      return [...recipeRows.entries()]
        .filter(([key]) => key.startsWith(`${target.subject}\n`))
        .map(([, row]) => row);
    },
    async releaseStale(olderThan) {
      let count = 0;
      for (const row of crawls.values()) {
        if ((row.status === 'queued' || row.status === 'running') && row.updatedAt < olderThan) {
          row.status = 'stopped';
          row.error = 'interrupted';
          count += 1;
        }
      }
      return count;
    },
    async sweepExpired(now) {
      let count = 0;
      for (const [id, row] of crawls) {
        if (row.expiresAt < now) {
          crawls.delete(id);
          pageRows.delete(id);
          count += 1;
        }
      }
      return count;
    },
  };
}

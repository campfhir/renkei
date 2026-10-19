/**
 * Postgres for web crawls (migration 156): the crawl, the pages it read,
 * and the recipes saved by name. Every read and write names the subject
 * and filters on it — no cross-caller reads, the store.ts discipline.
 *
 * A page's content — its text and its tables as rows — is sealed before
 * it is written, under a key derived for its subject from the worker's
 * sealing key (the browser-state arrangement): a database copy alone shows
 * which URLs were read, never what they said. A worker with no sealing key
 * stores no content at all; the crawl endpoints refuse instead.
 */

import { hkdfSync } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB, Json } from '@renkei/db';
import { decrypt, encrypt } from '@renkei/crypto';
import type { CrawlRecipe } from '@renkei/connector-sandbox';
import type { CrawledTable } from './crawl-page-script';

export interface CrawlTarget {
  subject: string;
}

export type CrawlStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed';

export interface QueuedPage {
  url: string;
  depth: number;
}

export interface CrawlRow {
  id: string;
  subject: string;
  recipeName: string | null;
  recipe: CrawlRecipe;
  status: CrawlStatus;
  queue: QueuedPage[];
  pagesDone: number;
  pagesFailed: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface PageContent {
  title: string;
  region: 'main' | 'page';
  text: string;
  textTruncated: boolean;
  tables: CrawledTable[];
}

export interface PageSummary {
  url: string;
  seq: number;
  depth: number;
  status: 'ok' | 'failed';
  title: string | null;
  textChars: number;
  tableCount: number;
  error: string | null;
}

export interface StoredPage extends PageSummary {
  content: PageContent | null;
}

export interface RecipeRow {
  name: string;
  recipe: CrawlRecipe;
  lastCrawlId: string | null;
  updatedAt: Date;
}

/** What the crawler needs of storage — a Postgres store in production, a Map in tests. */
export interface CrawlStore {
  create(input: {
    target: CrawlTarget;
    recipe: CrawlRecipe;
    recipeName: string | null;
    queue: QueuedPage[];
    expiresAt: Date;
  }): Promise<CrawlRow>;
  get(target: CrawlTarget, id: string): Promise<CrawlRow | null>;
  /** The crawler's own read of a crawl it is running — no caller to scope to. */
  getById(id: string): Promise<CrawlRow | null>;
  list(target: CrawlTarget, limit: number): Promise<CrawlRow[]>;
  /** Move to `to` only from one of `from`; false when another writer got there first. */
  transition(
    id: string,
    from: CrawlStatus[],
    to: CrawlStatus,
    error?: string | null
  ): Promise<boolean>;
  /** The crawl's progress after one page — also its heartbeat. */
  progress(
    id: string,
    update: { queue: QueuedPage[]; done: number; failed: number }
  ): Promise<void>;
  /** Give a stopped crawl more pages (a resume) and requeue it. */
  extend(id: string, recipe: CrawlRecipe): Promise<void>;
  putPage(
    crawlId: string,
    page: PageSummary,
    content: PageContent | null,
    subject: string
  ): Promise<void>;
  visited(crawlId: string): Promise<Set<string>>;
  pages(
    target: CrawlTarget,
    crawlId: string,
    query: { urls?: string[]; offset: number; limit: number; withContent: boolean }
  ): Promise<StoredPage[]>;
  saveRecipe(
    target: CrawlTarget,
    name: string,
    recipe: CrawlRecipe,
    crawlId: string | null
  ): Promise<void>;
  recipe(target: CrawlTarget, name: string): Promise<RecipeRow | null>;
  recipes(target: CrawlTarget): Promise<RecipeRow[]>;
  /** Crawls left 'running' or 'queued' by a worker that stopped: marked stopped, resumable. */
  releaseStale(olderThan: Date): Promise<number>;
  sweepExpired(now: Date): Promise<number>;
}

const PREFIX = 'crawl1.';
const HKDF_SALT = 'renkei-crawl-pages';

/** The key a subject's crawled pages are sealed under (the browser-state derivation). */
export function crawlContentKey(rootKey: Buffer, domain: string, subject: string): Buffer {
  return Buffer.from(hkdfSync('sha256', rootKey, HKDF_SALT, `${domain}\n${subject}`, 32));
}

export function sealPageContent(content: PageContent, key: Buffer): string {
  return `${PREFIX}${encrypt(JSON.stringify(content), key)}`;
}

export function openPageContent(sealed: string, key: Buffer): PageContent | null {
  if (!sealed.startsWith(PREFIX)) return null;
  const opened = decrypt(sealed.slice(PREFIX.length), key);
  if (!opened.ok) return null;
  try {
    const parsed: unknown = JSON.parse(opened.val);
    return isPageContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPageContent(value: unknown): value is PageContent {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.text === 'string' &&
    Array.isArray(value.tables)
  );
}

function isRecipe(value: unknown): value is CrawlRecipe {
  return (
    isRecord(value) &&
    typeof value.origin === 'string' &&
    typeof value.pattern === 'string' &&
    typeof value.maxPages === 'number'
  );
}

function queueOf(value: unknown): QueuedPage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.url === 'string' && typeof entry.depth === 'number'
      ? [{ url: entry.url, depth: entry.depth }]
      : []
  );
}

function statusOf(value: string): CrawlStatus {
  switch (value) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'stopped':
    case 'failed':
      return value;
    default:
      return 'failed';
  }
}

function json(value: unknown): Json {
  // Kysely takes a JSON column as its serialized text.
  return JSON.stringify(value);
}

/** The Postgres store; page content is sealed under keys derived from `rootKey` and `domain`. */
export function createCrawlStore(db: Kysely<DB>, rootKey: Buffer, domain: string): CrawlStore {
  const crawlColumns = [
    'id',
    'subject',
    'recipe_name',
    'recipe',
    'status',
    'queue',
    'pages_done',
    'pages_failed',
    'error',
    'created_at',
    'updated_at',
    'finished_at',
  ] as const;
  function toRow(row: {
    id: string;
    subject: string;
    recipe_name: string | null;
    recipe: unknown;
    status: string;
    queue: unknown;
    pages_done: number;
    pages_failed: number;
    error: string | null;
    created_at: Date;
    updated_at: Date;
    finished_at: Date | null;
  }): CrawlRow | null {
    if (!isRecipe(row.recipe)) return null;
    return {
      id: row.id,
      subject: row.subject,
      recipeName: row.recipe_name,
      recipe: row.recipe,
      status: statusOf(row.status),
      queue: queueOf(row.queue),
      pagesDone: row.pages_done,
      pagesFailed: row.pages_failed,
      error: row.error,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    };
  }

  return {
    async create(input) {
      const row = await db
        .insertInto('sandbox_crawls')
        .values({
          subject: input.target.subject,
          recipe_name: input.recipeName,
          recipe: json(input.recipe),
          status: 'queued',
          queue: json(input.queue),
          expires_at: input.expiresAt,
        })
        .returning(crawlColumns)
        .executeTakeFirstOrThrow();
      const parsed = toRow(row);
      if (!parsed) throw new Error('crawl row did not read back');
      return parsed;
    },

    async get(target, id) {
      const row = await db
        .selectFrom('sandbox_crawls')
        .select(crawlColumns)
        .where('id', '=', id)
        .where('subject', '=', target.subject)
        .executeTakeFirst();
      return row ? toRow(row) : null;
    },

    async getById(id) {
      const row = await db
        .selectFrom('sandbox_crawls')
        .select(crawlColumns)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? toRow(row) : null;
    },

    async list(target, limit) {
      const rows = await db
        .selectFrom('sandbox_crawls')
        .select(crawlColumns)
        .where('subject', '=', target.subject)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute();
      return rows.flatMap((row) => toRow(row) ?? []);
    },

    async transition(id, from, to, error) {
      const finished = to === 'completed' || to === 'stopped' || to === 'failed';
      const result = await db
        .updateTable('sandbox_crawls')
        .set({
          status: to,
          updated_at: sql`NOW()`,
          ...(finished ? { finished_at: sql`NOW()` } : { finished_at: null }),
          ...(error !== undefined ? { error } : {}),
        })
        .where('id', '=', id)
        .where('status', 'in', from)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },

    async progress(id, update) {
      await db
        .updateTable('sandbox_crawls')
        .set({
          queue: json(update.queue),
          pages_done: update.done,
          pages_failed: update.failed,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .execute();
    },

    async extend(id, recipe) {
      await db
        .updateTable('sandbox_crawls')
        .set({ recipe: json(recipe), status: 'queued', error: null, updated_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();
    },

    async putPage(crawlId, page, content, subject) {
      const sealed = content
        ? sealPageContent(content, crawlContentKey(rootKey, domain, subject))
        : null;
      await db
        .insertInto('sandbox_crawl_pages')
        .values({
          crawl_id: crawlId,
          url: page.url,
          seq: page.seq,
          depth: page.depth,
          status: page.status,
          title: page.title,
          content: sealed,
          text_chars: page.textChars,
          table_count: page.tableCount,
          error: page.error,
        })
        .onConflict((conflict) =>
          conflict.columns(['crawl_id', 'url']).doUpdateSet({
            status: page.status,
            title: page.title,
            content: sealed,
            text_chars: page.textChars,
            table_count: page.tableCount,
            error: page.error,
            fetched_at: sql`NOW()`,
          })
        )
        .execute();
    },

    async visited(crawlId) {
      const rows = await db
        .selectFrom('sandbox_crawl_pages')
        .select('url')
        .where('crawl_id', '=', crawlId)
        .execute();
      return new Set(rows.map((row) => row.url));
    },

    async pages(target, crawlId, query) {
      // The crawl is the subject's, or nothing comes back.
      let select = db
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
        .where('c.subject', '=', target.subject);
      if (query.urls && query.urls.length > 0) select = select.where('p.url', 'in', query.urls);
      const rows = await select.orderBy('p.seq').offset(query.offset).limit(query.limit).execute();
      const key = query.withContent ? crawlContentKey(rootKey, domain, target.subject) : null;
      return rows.map((row) => ({
        url: row.url,
        seq: row.seq,
        depth: row.depth,
        status: row.status === 'ok' ? 'ok' : 'failed',
        title: row.title,
        textChars: row.text_chars,
        tableCount: row.table_count,
        error: row.error,
        content: key && row.content ? openPageContent(row.content, key) : null,
      }));
    },

    async saveRecipe(target, name, recipe, crawlId) {
      await db
        .insertInto('sandbox_crawl_recipes')
        .values({
          subject: target.subject,
          name,
          recipe: json(recipe),
          last_crawl_id: crawlId,
        })
        .onConflict((conflict) =>
          conflict.columns(['subject', 'name']).doUpdateSet({
            recipe: json(recipe),
            last_crawl_id: crawlId,
            updated_at: sql`NOW()`,
          })
        )
        .execute();
    },

    async recipe(target, name) {
      const row = await db
        .selectFrom('sandbox_crawl_recipes')
        .select(['name', 'recipe', 'last_crawl_id', 'updated_at'])
        .where('subject', '=', target.subject)
        .where('name', '=', name)
        .executeTakeFirst();
      if (!row || !isRecipe(row.recipe)) return null;
      return {
        name: row.name,
        recipe: row.recipe,
        lastCrawlId: row.last_crawl_id,
        updatedAt: new Date(row.updated_at),
      };
    },

    async recipes(target) {
      const rows = await db
        .selectFrom('sandbox_crawl_recipes')
        .select(['name', 'recipe', 'last_crawl_id', 'updated_at'])
        .where('subject', '=', target.subject)
        .orderBy('updated_at', 'desc')
        .execute();
      return rows.flatMap((row) =>
        isRecipe(row.recipe)
          ? [
              {
                name: row.name,
                recipe: row.recipe,
                lastCrawlId: row.last_crawl_id,
                updatedAt: new Date(row.updated_at),
              },
            ]
          : []
      );
    },

    async releaseStale(olderThan) {
      const result = await db
        .updateTable('sandbox_crawls')
        .set({
          status: 'stopped',
          error: 'The crawl was interrupted (the sandbox worker restarted). Resume it to carry on.',
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('status', 'in', ['queued', 'running'])
        .where('updated_at', '<', olderThan)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },

    async sweepExpired(now) {
      const result = await db
        .deleteFrom('sandbox_crawls')
        .where('expires_at', '<', now)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}

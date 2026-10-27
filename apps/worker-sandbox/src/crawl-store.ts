/**
 * Web crawls (migration 156), through the data store (`sandboxCrawls`):
 * the crawl, the pages it read, and the recipes saved by name. Every read
 * and write names the subject and filters on it — no cross-caller reads,
 * the store.ts discipline.
 *
 * A page's content — its text and its tables as rows — is sealed before
 * it is written, under a key derived for its subject from the worker's
 * sealing key (the browser-state arrangement): a database copy alone shows
 * which URLs were read, never what they said. A worker with no sealing key
 * stores no content at all; the crawl endpoints refuse instead.
 */

import { hkdfSync } from 'node:crypto';
import { getDataStore, type SandboxCrawlRecipeRecord, type SandboxCrawlRecord } from '@renkei/db';
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

/** What the crawler needs of storage — the data store in production, a Map in tests. */
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

const STALE_ERROR =
  'The crawl was interrupted (the sandbox worker restarted). Resume it to carry on.';

function toRow(record: SandboxCrawlRecord): CrawlRow | null {
  if (!isRecipe(record.recipe)) return null;
  return {
    id: record.id,
    subject: record.subject,
    recipeName: record.recipeName,
    recipe: record.recipe,
    status: statusOf(record.status),
    queue: queueOf(record.queue),
    pagesDone: record.pagesDone,
    pagesFailed: record.pagesFailed,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt,
  };
}

function toRecipe(record: SandboxCrawlRecipeRecord): RecipeRow | null {
  if (!isRecipe(record.recipe)) return null;
  return {
    name: record.name,
    recipe: record.recipe,
    lastCrawlId: record.lastCrawlId,
    updatedAt: record.updatedAt,
  };
}

/**
 * The store over the data store (`sandboxCrawls`); page content is sealed
 * under keys derived from `rootKey` and `domain` before it is written.
 */
export function createCrawlStore(rootKey: Buffer, domain: string): CrawlStore {
  const crawls = () => getDataStore().sandboxCrawls;

  return {
    async create(input) {
      const record = await crawls().create({
        subject: input.target.subject,
        recipeName: input.recipeName,
        recipe: input.recipe,
        queue: input.queue,
        expiresAt: input.expiresAt,
      });
      const parsed = toRow(record);
      if (!parsed) throw new Error('crawl row did not read back');
      return parsed;
    },

    async get(target, id) {
      const record = await crawls().get(target.subject, id);
      return record ? toRow(record) : null;
    },

    async getById(id) {
      const record = await crawls().getById(id);
      return record ? toRow(record) : null;
    },

    async list(target, limit) {
      return (await crawls().list(target.subject, limit)).flatMap((record) => toRow(record) ?? []);
    },

    async transition(id, from, to, error) {
      const now = new Date();
      const finished = to === 'completed' || to === 'stopped' || to === 'failed';
      return crawls().transition(id, from, to, {
        at: now,
        finishedAt: finished ? now : null,
        ...(error !== undefined ? { error } : {}),
      });
    },

    async progress(id, update) {
      await crawls().progress(id, {
        queue: update.queue,
        done: update.done,
        failed: update.failed,
        at: new Date(),
      });
    },

    async extend(id, recipe) {
      await crawls().extend(id, recipe, new Date());
    },

    async putPage(crawlId, page, content, subject) {
      const sealed = content
        ? sealPageContent(content, crawlContentKey(rootKey, domain, subject))
        : null;
      await crawls().putPage(crawlId, { ...page, content: sealed }, new Date());
    },

    async visited(crawlId) {
      return new Set(await crawls().visitedUrls(crawlId));
    },

    async pages(target, crawlId, query) {
      const records = await crawls().pages(target.subject, crawlId, {
        urls: query.urls,
        offset: query.offset,
        limit: query.limit,
      });
      const key = query.withContent ? crawlContentKey(rootKey, domain, target.subject) : null;
      return records.map((record) => ({
        url: record.url,
        seq: record.seq,
        depth: record.depth,
        status: record.status === 'ok' ? 'ok' : 'failed',
        title: record.title,
        textChars: record.textChars,
        tableCount: record.tableCount,
        error: record.error,
        content: key && record.content ? openPageContent(record.content, key) : null,
      }));
    },

    async saveRecipe(target, name, recipe, crawlId) {
      await crawls().saveRecipe(target.subject, name, recipe, crawlId, new Date());
    },

    async recipe(target, name) {
      const record = await crawls().recipe(target.subject, name);
      return record ? toRecipe(record) : null;
    },

    async recipes(target) {
      return (await crawls().recipes(target.subject)).flatMap((record) => toRecipe(record) ?? []);
    },

    async releaseStale(olderThan) {
      return crawls().releaseStale(olderThan, { error: STALE_ERROR, at: new Date() });
    },

    async sweepExpired(now) {
      return crawls().sweepExpired(now);
    },
  };
}

/**
 * Web crawls on the sandbox worker: the crawl (sandbox_crawls), the pages
 * it read (sandbox_crawl_pages) and the recipes saved by name
 * (sandbox_crawl_recipes). A page's content is kept as the sealed text the
 * worker hands in — sealing, opening and validating a recipe's shape are
 * the worker's. Every per-caller read names the subject; the crawler's own
 * bookkeeping goes by crawl id, and the sweeps read across callers.
 * Timestamps are the caller's (`at`).
 */

export interface SandboxCrawlRecord {
  id: string;
  subject: string;
  recipeName: string | null;
  /** The recipe as stored (JSON). */
  recipe: unknown;
  /** As stored: 'queued', 'running', 'completed', 'stopped' or 'failed'. */
  status: string;
  /** The pages still to visit, as stored (JSON). */
  queue: unknown;
  pagesDone: number;
  pagesFailed: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface SandboxCrawlPageRecord {
  url: string;
  seq: number;
  depth: number;
  status: string;
  title: string | null;
  /** The sealed content, or null when none was kept. */
  content: string | null;
  textChars: number;
  tableCount: number;
  error: string | null;
}

export interface SandboxCrawlRecipeRecord {
  name: string;
  recipe: unknown;
  lastCrawlId: string | null;
  updatedAt: Date;
}

export interface SandboxCrawlStore {
  /** A new crawl, 'queued' (`id` generated unless given). */
  create(crawl: {
    id?: string;
    subject: string;
    recipeName: string | null;
    recipe: unknown;
    queue: unknown;
    expiresAt: Date;
  }): Promise<SandboxCrawlRecord>;
  get(subject: string, id: string): Promise<SandboxCrawlRecord | null>;
  /** The crawler's own read of a crawl it is running. */
  getById(id: string): Promise<SandboxCrawlRecord | null>;
  /** The subject's crawls, newest first (ties by id), at most `limit`. */
  list(subject: string, limit: number): Promise<SandboxCrawlRecord[]>;
  /**
   * Move to `to` only from one of `from`, stamping `at` and `finishedAt`
   * (and the error, when given); false when the crawl was in no such state.
   */
  transition(
    id: string,
    from: string[],
    to: string,
    change: { at: Date; finishedAt: Date | null; error?: string | null }
  ): Promise<boolean>;
  /** The crawl's progress after one page. */
  progress(
    id: string,
    update: { queue: unknown; done: number; failed: number; at: Date }
  ): Promise<void>;
  /** A new recipe, requeued, the error cleared. */
  extend(id: string, recipe: unknown, at: Date): Promise<void>;
  /** Record a page (or replace what an earlier visit to its URL recorded). */
  putPage(crawlId: string, page: SandboxCrawlPageRecord, at: Date): Promise<void>;
  /** The URLs a crawl has recorded pages for, sorted. */
  visitedUrls(crawlId: string): Promise<string[]>;
  /**
   * A page of one of the subject's crawl's pages, by seq (ties by url),
   * optionally only these URLs; nothing when the crawl is not the subject's.
   */
  pages(
    subject: string,
    crawlId: string,
    query: { urls?: string[]; offset: number; limit: number }
  ): Promise<SandboxCrawlPageRecord[]>;
  /** Save a recipe under a name, replacing one saved before. */
  saveRecipe(
    subject: string,
    name: string,
    recipe: unknown,
    crawlId: string | null,
    at: Date
  ): Promise<void>;
  recipe(subject: string, name: string): Promise<SandboxCrawlRecipeRecord | null>;
  /** The subject's recipes, most recently saved first (ties by name). */
  recipes(subject: string): Promise<SandboxCrawlRecipeRecord[]>;
  /** Crawls queued or running, untouched since `olderThan`: stopped with this error; how many. */
  releaseStale(olderThan: Date, change: { error: string; at: Date }): Promise<number>;
  /** Delete crawls (and their pages) expired before `now`; how many. */
  sweepExpired(now: Date): Promise<number>;
}

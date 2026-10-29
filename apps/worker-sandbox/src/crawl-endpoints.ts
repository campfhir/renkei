/**
 * The crawl verbs — `/v1/crawls/<op>`, one JSON POST each, the caller's
 * subject naming whose crawls they are (as it names their browser
 * session and staged files):
 *
 *   start   — validate a plan (or load a saved recipe), start the crawl in
 *             the background, answer at once; `saveAs` keeps the recipe.
 *   resume  — carry a stopped crawl (or a recipe's last crawl) on.
 *   stop    — stop a crawl after the page it is on.
 *   status  — one crawl and its page list, optionally waiting (≤45 s) for
 *             it to finish; with no crawl named, recent crawls and saved
 *             recipes.
 *   pages   — the pages' content: text and tables as rows.
 *
 * Gated like the browser: the organization's browser switch, and a worker
 * that has a browser and a sealing key (crawled pages are never stored in
 * the clear).
 */

import type { ServerResponse } from 'node:http';
import { planCrawl, type CrawlRecipe } from '@renkei/connector-sandbox';
import { CrawlError, type Crawler } from './crawler';
import type { CrawlRow, CrawlStore, CrawlTarget, RecipeRow, StoredPage } from './crawl-store';
import { logErrorResponse } from './request-log';

/** Longest a status call may wait — inside an agent's 60 s tool-call limit. */
export const CRAWL_STATUS_MAX_WAIT_MS = 45_000;
const STATUS_POLL_MS = 1_000;
const MAX_PAGES_PER_READ = 50;
const MAX_PAGE_LIST = 500;
const RECIPE_NAME = /^[\w .:/()-]{1,100}$/;

export interface CrawlHandlerDeps {
  crawler: Crawler | null;
  store: CrawlStore | null;
  /** The organization's browser switch, asked per request. */
  enabledFor: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Body = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, type: string, message?: string): void {
  logErrorResponse(status, type, message);
  sendJson(response, status, { error: { type, message } });
}

export function crawlWire(crawl: CrawlRow) {
  return {
    id: crawl.id,
    status: crawl.status,
    recipeName: crawl.recipeName,
    recipe: crawl.recipe,
    pagesDone: crawl.pagesDone,
    pagesFailed: crawl.pagesFailed,
    pagesQueued: crawl.queue.length,
    nextUrls: crawl.queue.slice(0, 5).map((entry) => entry.url),
    error: crawl.error,
    createdAt: crawl.createdAt.toISOString(),
    updatedAt: crawl.updatedAt.toISOString(),
    finishedAt: crawl.finishedAt ? crawl.finishedAt.toISOString() : null,
  };
}

function pageWire(page: StoredPage, withContent: boolean) {
  return {
    url: page.url,
    seq: page.seq,
    depth: page.depth,
    status: page.status,
    title: page.title,
    textChars: page.textChars,
    tableCount: page.tableCount,
    error: page.error,
    ...(withContent ? { content: page.content } : {}),
  };
}

function recipeWire(recipe: RecipeRow) {
  return {
    name: recipe.name,
    recipe: recipe.recipe,
    lastCrawlId: recipe.lastCrawlId,
    updatedAt: recipe.updatedAt.toISOString(),
  };
}

export function createCrawlHandlers(deps: CrawlHandlerDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  async function crawlNamed(
    store: CrawlStore,
    target: CrawlTarget,
    body: Body
  ): Promise<CrawlRow | string> {
    const id = str(body.crawlId);
    if (id) return (await store.get(target, id)) ?? 'No such crawl.';
    const name = str(body.recipe);
    if (name) {
      const recipe = await store.recipe(target, name);
      if (!recipe) return `No saved crawl recipe is named "${name}".`;
      if (!recipe.lastCrawlId) return `The recipe "${name}" has not been crawled yet.`;
      return (
        (await store.get(target, recipe.lastCrawlId)) ?? 'That recipe’s last crawl has expired.'
      );
    }
    return 'Name a crawl (crawlId) or a saved recipe (recipe).';
  }

  async function handleCrawls(op: string, body: Body, response: ServerResponse): Promise<void> {
    const { crawler, store } = deps;
    if (!crawler || !store) {
      return sendError(
        response,
        503,
        'crawl_unavailable',
        'The crawler is not available on this deployment (it needs the sandbox browser and a sealing key).'
      );
    }
    const subject = str(body.subject);
    if (!subject) return sendError(response, 400, 'bad_request');
    const target: CrawlTarget = { subject };
    if (!(await deps.enabledFor())) {
      return sendError(
        response,
        503,
        'crawl_unavailable',
        'The sandbox browser is not enabled for this organization (admin → Settings → Sandbox).'
      );
    }

    try {
      switch (op) {
        case 'start': {
          const saveAs = str(body.saveAs);
          if (saveAs && !RECIPE_NAME.test(saveAs)) {
            return sendError(
              response,
              400,
              'bad_request',
              'saveAs is a short name: letters, digits, spaces and . : / ( ) - _ (at most 100).'
            );
          }
          let input: unknown = body.plan;
          let recipeName: string | null = saveAs || null;
          let saveRecipe: CrawlRecipe | undefined;
          const fromRecipe = str(body.recipe);
          if (fromRecipe) {
            const saved = await store.recipe(target, fromRecipe);
            if (!saved) {
              return sendError(
                response,
                404,
                'not_found',
                `No saved crawl recipe is named "${fromRecipe}".`
              );
            }
            input = {
              ...saved.recipe,
              ...(num(body.maxPages) ? { maxPages: num(body.maxPages) } : {}),
            };
            recipeName = saveAs || saved.name;
            // A one-off budget is this crawl's, not the recipe's.
            saveRecipe = saved.recipe;
          }
          const plan = planCrawl(input);
          if (!plan.ok) return sendError(response, 400, 'bad_request', plan.error);
          const crawl = await crawler.start(target, {
            recipe: plan.recipe,
            seeds: plan.seeds,
            recipeName,
            ...(saveRecipe ? { saveRecipe } : {}),
          });
          return sendJson(response, 200, { crawl: crawlWire(crawl), seeds: plan.seeds.length });
        }
        case 'resume': {
          const named = await crawlNamed(store, target, body);
          if (typeof named === 'string') return sendError(response, 404, 'not_found', named);
          const crawl = await crawler.resume(target, named.id, num(body.maxPages));
          return sendJson(response, 200, { crawl: crawlWire(crawl) });
        }
        case 'stop': {
          const named = await crawlNamed(store, target, body);
          if (typeof named === 'string') return sendError(response, 404, 'not_found', named);
          const stopped = await crawler.stop(target, named.id);
          const crawl = (await store.get(target, named.id)) ?? named;
          return sendJson(response, 200, { stopped, crawl: crawlWire(crawl) });
        }
        case 'status': {
          if (!str(body.crawlId) && !str(body.recipe)) {
            const [crawls, recipes] = await Promise.all([
              store.list(target, 20),
              store.recipes(target),
            ]);
            return sendJson(response, 200, {
              crawls: crawls.map(crawlWire),
              recipes: recipes.map(recipeWire),
            });
          }
          let named = await crawlNamed(store, target, body);
          if (typeof named === 'string') return sendError(response, 404, 'not_found', named);
          const waitMs = Math.min(CRAWL_STATUS_MAX_WAIT_MS, Math.max(0, num(body.waitMs) ?? 0));
          const deadline = now() + waitMs;
          while ((named.status === 'queued' || named.status === 'running') && now() < deadline) {
            await sleep(Math.min(STATUS_POLL_MS, deadline - now()));
            named = (await store.get(target, named.id)) ?? named;
          }
          const offset = Math.max(0, num(body.pageOffset) ?? 0);
          const limit = Math.min(MAX_PAGE_LIST, Math.max(1, num(body.pageLimit) ?? MAX_PAGE_LIST));
          const pages = await store.pages(target, named.id, { offset, limit, withContent: false });
          return sendJson(response, 200, {
            crawl: crawlWire(named),
            pages: pages.map((page) => pageWire(page, false)),
          });
        }
        case 'pages': {
          const id = str(body.crawlId);
          if (!id) return sendError(response, 400, 'bad_request', 'Name the crawl (crawlId).');
          const crawl = await store.get(target, id);
          if (!crawl) return sendError(response, 404, 'not_found', 'No such crawl.');
          const urls = Array.isArray(body.urls)
            ? body.urls
                .filter((url): url is string => typeof url === 'string')
                .slice(0, MAX_PAGES_PER_READ)
            : [];
          const offset = Math.max(0, num(body.offset) ?? 0);
          const limit = Math.min(MAX_PAGES_PER_READ, Math.max(1, num(body.limit) ?? 10));
          const pages = await store.pages(target, id, { urls, offset, limit, withContent: true });
          return sendJson(response, 200, {
            crawl: crawlWire(crawl),
            pages: pages.map((page) => pageWire(page, true)),
          });
        }
        default:
          return sendError(response, 404, 'unknown_operation');
      }
    } catch (error) {
      if (error instanceof CrawlError) {
        const status = error.type === 'not_found' ? 404 : error.type === 'busy' ? 409 : 400;
        return sendError(response, status, error.type, error.message);
      }
      throw error;
    }
  }

  return { handleCrawls };
}

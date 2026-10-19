/**
 * Web crawls: many pages of one site read by ONE approved call, instead of
 * a staged sandbox_browser_navigate per page.
 *
 *  - sandbox_crawl_plan (read): check a crawl's scope, or learn it from two
 *    or more example URLs, and see exactly which pages it would read —
 *    nothing is fetched.
 *  - sandbox_browser_crawl (act): start the crawl. Its scope is the
 *    approval: one https origin, the pages it names (a list, a {value}
 *    template, start pages whose links are followed) and a path pattern a
 *    followed link must match — so an agent stages it once, a person (or
 *    auto-accept) approves that scope once, and the worker reads every
 *    page in the background. A page can never steer it elsewhere
 *    (@renkei/connector-sandbox crawl.ts). `saveAs` keeps the recipe by
 *    name; `recipe` re-crawls one; `resume` carries a stopped crawl on.
 *  - sandbox_crawl_status (read): progress and the page list, waiting up
 *    to 45 s for the crawl to finish; with nothing named, recent crawls
 *    and saved recipes.
 *  - sandbox_crawl_read (read): pages' content — the main text and every
 *    table as a Markdown table, several pages per call.
 *  - sandbox_crawl_stop (act): stop a crawl after its current page.
 *
 * Registered with the browser tools: the organization's browser switch
 * and a worker with a browser gate both.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CRAWL_DEFAULT_PAGES,
  CRAWL_MAX_DEPTH,
  CRAWL_MAX_PAGES,
  inferCrawlPattern,
  planCrawl,
  type CrawlPlanResult,
} from '@renkei/connector-sandbox';
import type { MCPToolContext } from '../common';
import { errText, str, targetOf, textResult } from './shared';
import {
  clientFailure,
  sbCrawlList,
  sbCrawlPages,
  sbCrawlResume,
  sbCrawlStart,
  sbCrawlStatus,
  sbCrawlStop,
  type WireCrawl,
  type WireCrawlPage,
  type WireCrawlTable,
} from '@/lib/sandbox/service-client';

/** The most a read hands back, and its default. */
const READ_MAX_CHARS = 30_000;
const READ_DEFAULT_CHARS = 20_000;
const READ_MAX_PAGES = 20;
const STATUS_MAX_WAIT_SECONDS = 45;
const STATUS_PAGE_LINES = 200;

const planFields = {
  origin: z
    .string()
    .optional()
    .describe('The https origin every page is on, e.g. "https://docs.example.com".'),
  pattern: z
    .string()
    .optional()
    .describe(
      'Path glob a FOLLOWED link must match: "*" is one path segment, "**" any depth — e.g. "/v2/HL7v2.3/Segments/*". Omit it to learn it from examples.'
    ),
  urls: z
    .array(z.string())
    .max(CRAWL_MAX_PAGES)
    .optional()
    .describe('Pages to read, named outright.'),
  template: z
    .object({
      url: z
        .string()
        .describe('A URL with "{value}" exactly once, e.g. "https://x.com/items/{value}".'),
      values: z.array(z.string()).max(CRAWL_MAX_PAGES).describe('One page per value.'),
    })
    .optional(),
  follow: z
    .object({
      from: z.array(z.string()).min(1).describe('Start pages (an index or list page).'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(CRAWL_MAX_DEPTH)
        .optional()
        .describe('How many links away from a start page (default 1).'),
    })
    .optional()
    .describe(
      'Read the start pages and every link on them that is on the origin and matches the pattern. Long lists that load as they scroll are scrolled through.'
    ),
  examples: z
    .array(z.string())
    .min(2)
    .max(20)
    .optional()
    .describe(
      'Two or more example page URLs to learn the origin and pattern from (and, when one path segment varies, a template). Read a couple of pages by hand first, then pass them here.'
    ),
  region: z
    .enum(['auto', 'main', 'page'])
    .optional()
    .describe('Keep the page\'s <main> content ("auto": when it has one) or the whole page.'),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(CRAWL_MAX_PAGES)
    .optional()
    .describe(
      `Most pages to read (default: the pages named, or ${CRAWL_DEFAULT_PAGES} when following links; at most ${CRAWL_MAX_PAGES}). A crawl that reaches it stops and can be resumed.`
    ),
};

type PlanArgs = Record<string, unknown>;

/**
 * The plan a call describes: fields given outright, gaps filled from
 * `examples` — the origin and pattern always, and the pages themselves
 * when none were named (the learned template over the examples' values,
 * else the examples as a list).
 */
export function planFromArgs(args: PlanArgs): CrawlPlanResult & { learned?: string } {
  const input: Record<string, unknown> = {
    ...(args.origin !== undefined ? { origin: args.origin } : {}),
    ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
    ...(args.urls !== undefined ? { urls: args.urls } : {}),
    ...(args.template !== undefined ? { template: args.template } : {}),
    ...(args.follow !== undefined ? { follow: args.follow } : {}),
    ...(args.region !== undefined ? { region: args.region } : {}),
    ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
  };
  let learned: string | undefined;
  const examples = Array.isArray(args.examples)
    ? args.examples.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (examples.length > 0) {
    const inferred = inferCrawlPattern(examples);
    if (!inferred.ok) return { ok: false, error: inferred.error };
    input.origin ??= inferred.origin;
    input.pattern ??= inferred.pattern;
    const named =
      input.urls !== undefined || input.template !== undefined || input.follow !== undefined;
    if (!named) {
      if (inferred.template) input.template = inferred.template;
      else input.urls = examples;
    }
    learned =
      `Learned from the examples: origin ${inferred.origin}, pattern ${inferred.pattern}` +
      (inferred.template ? `, template ${inferred.template.url}` : '') +
      '.';
  }
  const plan = planCrawl(input);
  return learned ? { ...plan, learned } : plan;
}

function planText(plan: Extract<CrawlPlanResult, { ok: true }>, learned?: string): string {
  const { recipe, seeds } = plan;
  const lines = [
    ...(learned ? [learned] : []),
    `Origin: ${recipe.origin}`,
    `Pattern for followed links: ${recipe.pattern}`,
    `Pages named: ${seeds.length}${recipe.follow ? ` (plus in-pattern links up to ${recipe.follow.depth} away from ${recipe.follow.from.length} start page(s))` : ''}`,
    `Page budget: ${recipe.maxPages}`,
    `Region kept: ${recipe.region}`,
    'First pages:',
    ...seeds.slice(0, 10).map((url) => `- ${url}`),
    ...(seeds.length > 10 ? [`- … and ${seeds.length - 10} more`] : []),
    '',
    'The recipe, to pass to sandbox_browser_crawl as it is:',
    JSON.stringify(recipe),
  ];
  return lines.join('\n');
}

function crawlLine(crawl: WireCrawl): string {
  const name = crawl.recipeName ? ` "${crawl.recipeName}"` : '';
  return (
    `Crawl ${crawl.id}${name} — ${crawl.status}: ${crawl.pagesDone} read, ${crawl.pagesFailed} failed, ` +
    `${crawl.pagesQueued} still queued (budget ${crawl.recipe.maxPages}) — ${crawl.recipe.origin}${crawl.recipe.pattern}` +
    (crawl.error ? ` — ${crawl.error}` : '')
  );
}

function pageLine(page: WireCrawlPage): string {
  return page.status === 'ok'
    ? `${page.seq}. ${page.title ?? '(untitled)'} — ${page.url} — ${page.textChars} chars, ${page.tableCount} table(s)`
    : `${page.seq}. FAILED ${page.url} — ${page.error ?? 'no reason given'}`;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/** A crawled table as Markdown: header row (or Column N), then its rows. */
export function tableMarkdown(table: WireCrawlTable): string {
  const width = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 1);
  const headers = Array.from(
    { length: width },
    (_, index) => cell(table.headers[index] ?? '') || `Column ${index + 1}`
  );
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...table.rows.map(
      (row) =>
        `| ${Array.from({ length: width }, (_, index) => cell(row[index] ?? '')).join(' | ')} |`
    ),
  ];
  return lines.join('\n');
}

export function pageMarkdown(page: WireCrawlPage, include: 'all' | 'text' | 'tables'): string {
  const head = `## ${page.seq}. ${page.title ?? page.content?.title ?? '(untitled)'}\nURL: ${page.url}`;
  if (page.status !== 'ok' || !page.content) {
    return `${head}\nNot read: ${page.error ?? 'no content was kept.'}`;
  }
  const parts = [head];
  if (include !== 'tables' && page.content.text) {
    parts.push(
      page.content.text +
        (page.content.textTruncated ? '\n… [page text cut at the crawl’s limit]' : '')
    );
  }
  if (include !== 'text') {
    page.content.tables.forEach((table, index) => {
      parts.push(`Table ${index + 1} (${table.rows.length} rows):\n${tableMarkdown(table)}`);
    });
    if (page.content.tables.length === 0 && include === 'tables') parts.push('(no tables)');
  }
  return parts.join('\n\n');
}

export function registerSandboxCrawlTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'sandbox_crawl_plan',
    {
      title: 'Sandbox · Read — Plan a web crawl',
      description:
        'Check a crawl before starting it: which origin and pattern it is scoped to and exactly ' +
        'which pages it would read. Give the scope outright, or give two or more example page URLs ' +
        'and the origin, pattern and (when one path segment varies) a {value} template are learned ' +
        'from them. Nothing is fetched. The answer ends with the recipe to pass to ' +
        'sandbox_browser_crawl. Prefer one crawl over many sandbox_browser_navigate calls whenever ' +
        'you need more than two or three pages of one site.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object(planFields),
    },
    async (args: PlanArgs) => {
      const plan = planFromArgs(args);
      if (!plan.ok) return errText(plan.error);
      return textResult(planText(plan, plan.learned));
    }
  );

  server.registerTool(
    'sandbox_browser_crawl',
    {
      title: 'Sandbox · Act — Crawl many pages of a site in one go',
      description:
        'Read many pages of one website in a single call, in the background, in your sandbox ' +
        'browser: a list of URLs, a URL template over a list of values, or start pages whose ' +
        'links matching a pattern are followed (lists that load as they scroll are scrolled ' +
        'through). Every page keeps its main text and each table as rows. The crawl never leaves ' +
        'its origin or pattern. It returns at once with a crawl id: follow it with ' +
        'sandbox_crawl_status and read pages with sandbox_crawl_read. Check the scope first with ' +
        'sandbox_crawl_plan (or pass examples to learn it). saveAs keeps the recipe by name so a ' +
        'later run can re-crawl it (recipe) or carry on a stopped crawl (resume).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ...planFields,
        saveAs: z
          .string()
          .max(100)
          .optional()
          .describe('Save this crawl\'s recipe under a short name, e.g. "HL7 v2.3 segments".'),
        recipe: z
          .string()
          .max(100)
          .optional()
          .describe('Re-crawl a saved recipe by name (its scope as saved; maxPages may be given).'),
        resume: z
          .string()
          .optional()
          .describe(
            "Carry a stopped crawl on (its id, or a saved recipe name for that recipe's last crawl): the pages read stay, the queue it left is worked."
          ),
      }),
    },
    async (args: PlanArgs) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const maxPages = typeof args.maxPages === 'number' ? args.maxPages : undefined;
      const resume = str(args.resume).trim();
      if (resume) {
        const isId = /^[0-9a-f-]{36}$/i.test(resume);
        const resumed = await sbCrawlResume(target, {
          ...(isId ? { crawlId: resume } : { recipe: resume }),
          ...(maxPages ? { maxPages } : {}),
        });
        if (!resumed.ok) return errText(clientFailure(resumed.err).message);
        return textResult(
          `Resumed. ${crawlLine(resumed.val)}\nFollow it with sandbox_crawl_status {"crawlId":"${resumed.val.id}","waitSeconds":40}.`
        );
      }
      const saveAs = str(args.saveAs).trim();
      const recipe = str(args.recipe).trim();
      let started;
      let learned: string | undefined;
      if (recipe) {
        started = await sbCrawlStart(target, {
          recipe,
          ...(saveAs ? { saveAs } : {}),
          ...(maxPages ? { maxPages } : {}),
        });
      } else {
        const plan = planFromArgs(args);
        if (!plan.ok) return errText(plan.error);
        learned = plan.learned;
        started = await sbCrawlStart(target, { plan: plan.recipe, ...(saveAs ? { saveAs } : {}) });
      }
      if (!started.ok) return errText(clientFailure(started.err).message);
      const { crawl, seeds } = started.val;
      return textResult(
        [
          ...(learned ? [learned] : []),
          `Started. ${crawlLine(crawl)}`,
          `${seeds} page(s) named${crawl.recipe.follow ? ', plus the in-pattern links found on the start pages' : ''}.`,
          ...(crawl.recipeName ? [`Saved as the recipe "${crawl.recipeName}".`] : []),
          `Follow it with sandbox_crawl_status {"crawlId":"${crawl.id}","waitSeconds":40}; read pages with sandbox_crawl_read.`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'sandbox_crawl_status',
    {
      title: 'Sandbox · Read — How a web crawl is going',
      description:
        "A crawl's progress and the list of pages it has read (title, URL, size, tables, or why " +
        'one failed). waitSeconds (up to 45) waits for a running crawl to finish first — use it ' +
        'instead of calling repeatedly. With no crawl named, lists your recent crawls and saved ' +
        'recipes.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        crawlId: z.string().optional(),
        recipe: z.string().optional().describe('A saved recipe name: its last crawl.'),
        waitSeconds: z.number().int().min(0).max(STATUS_MAX_WAIT_SECONDS).optional(),
        pageOffset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Skip this many pages of the list.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const crawlId = str(args.crawlId).trim();
      const recipe = str(args.recipe).trim();
      if (!crawlId && !recipe) {
        const listed = await sbCrawlList(target);
        if (!listed.ok) return errText(clientFailure(listed.err).message);
        const { crawls, recipes } = listed.val;
        return textResult(
          [
            crawls.length > 0 ? 'Recent crawls:' : 'No crawls yet.',
            ...crawls.map((crawl) => `- ${crawlLine(crawl)}`),
            recipes.length > 0 ? '\nSaved recipes:' : '\nNo saved recipes.',
            ...recipes.map(
              (entry) =>
                `- "${entry.name}" — ${entry.recipe.origin}${entry.recipe.pattern}, budget ${entry.recipe.maxPages}${entry.lastCrawlId ? `, last crawl ${entry.lastCrawlId}` : ''}`
            ),
          ].join('\n')
        );
      }
      const waitSeconds = typeof args.waitSeconds === 'number' ? args.waitSeconds : 0;
      const pageOffset = typeof args.pageOffset === 'number' ? args.pageOffset : 0;
      const status = await sbCrawlStatus(target, {
        ...(crawlId ? { crawlId } : { recipe }),
        waitMs: waitSeconds * 1000,
        pageOffset,
        pageLimit: STATUS_PAGE_LINES,
      });
      if (!status.ok) return errText(clientFailure(status.err).message);
      const { crawl, pages } = status.val;
      const total = crawl.pagesDone + crawl.pagesFailed;
      const more = total > pageOffset + pages.length;
      return textResult(
        [
          crawlLine(crawl),
          ...(crawl.status === 'running' || crawl.status === 'queued'
            ? ['Still running — call again with waitSeconds to wait for more.']
            : crawl.status === 'stopped' && crawl.pagesQueued > 0
              ? [
                  `Stopped with pages left — sandbox_browser_crawl {"resume":"${crawl.id}"} carries it on.`,
                ]
              : []),
          '',
          ...pages.map(pageLine),
          ...(more
            ? [
                `… ${total - pageOffset - pages.length} more — call again with pageOffset ${pageOffset + pages.length}.`,
              ]
            : []),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'sandbox_crawl_read',
    {
      title: 'Sandbox · Read — Read pages a web crawl fetched',
      description:
        "The content of crawled pages: each page's main text and its tables as Markdown tables. " +
        'Read several pages per call — by URL, or in crawl order with offset and limit. ' +
        'include "tables" for just the tables (the compact way to pull structured data), "text" ' +
        'for just the text. The answer says where it stopped if it hit maxChars, so you can ' +
        'continue from there.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        crawlId: z.string(),
        urls: z.array(z.string()).max(READ_MAX_PAGES).optional(),
        offset: z.number().int().min(0).optional().describe('Pages to skip, in crawl order.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(READ_MAX_PAGES)
          .optional()
          .describe('Pages to read (default 5).'),
        include: z.enum(['all', 'text', 'tables']).optional(),
        maxChars: z
          .number()
          .int()
          .min(1_000)
          .max(READ_MAX_CHARS)
          .optional()
          .describe(`Cap on the answer (default ${READ_DEFAULT_CHARS}).`),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const crawlId = str(args.crawlId).trim();
      if (!crawlId) return errText('Name the crawl (crawlId).');
      const urls = Array.isArray(args.urls)
        ? args.urls.filter((url): url is string => typeof url === 'string')
        : [];
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const include = args.include === 'text' || args.include === 'tables' ? args.include : 'all';
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : READ_DEFAULT_CHARS;
      const read = await sbCrawlPages(target, {
        crawlId,
        ...(urls.length > 0 ? { urls } : { offset, limit }),
      });
      if (!read.ok) return errText(clientFailure(read.err).message);
      const { crawl, pages } = read.val;
      if (pages.length === 0) {
        return textResult(
          `${crawlLine(crawl)}\nNo pages ${urls.length > 0 ? 'at those URLs' : `from position ${offset}`}.`
        );
      }
      const parts: string[] = [];
      let used = 0;
      let shown = 0;
      for (const page of pages) {
        const text = pageMarkdown(page, include);
        if (used + text.length > maxChars) {
          if (shown === 0) {
            parts.push(`${text.slice(0, maxChars)}\n… [cut at maxChars]`);
            shown = 1;
          }
          break;
        }
        parts.push(text);
        used += text.length + 2;
        shown += 1;
      }
      const total = crawl.pagesDone + crawl.pagesFailed;
      const nextOffset = offset + shown;
      const notes =
        urls.length > 0
          ? shown < pages.length
            ? [`… ${pages.length - shown} of the requested pages did not fit — ask for them again.`]
            : []
          : nextOffset < total
            ? [`… ${total - nextOffset} more page(s) — continue with offset ${nextOffset}.`]
            : [];
      return textResult([...parts, ...notes].join('\n\n'));
    }
  );

  server.registerTool(
    'sandbox_crawl_stop',
    {
      title: 'Sandbox · Act — Stop a web crawl',
      description:
        'Stop a running crawl after the page it is on. What it has read stays; ' +
        'sandbox_browser_crawl with resume carries it on later.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        crawlId: z.string().optional(),
        recipe: z.string().optional().describe('A saved recipe name: its last crawl.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const crawlId = str(args.crawlId).trim();
      const recipe = str(args.recipe).trim();
      if (!crawlId && !recipe)
        return errText('Name the crawl (crawlId) or a saved recipe (recipe).');
      const stopped = await sbCrawlStop(target, crawlId ? { crawlId } : { recipe });
      if (!stopped.ok) return errText(clientFailure(stopped.err).message);
      return textResult(
        `${stopped.val.stopped ? 'Stopped.' : 'It was not running.'} ${crawlLine(stopped.val.crawl)}`
      );
    }
  );
}

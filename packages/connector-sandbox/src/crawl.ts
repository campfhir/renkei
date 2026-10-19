/**
 * The crawl plan behind `sandbox_browser_crawl`: which pages one approved
 * crawl may visit, worked out before a browser opens.
 *
 * A crawl is ONE staged action covering many pages, so what a person (or
 * auto-accept) approves has to be the whole of what the crawler may
 * reach. That is the recipe, and its scope is fixed by three things the
 * call names outright — never by what a page says:
 *   - `origin`: the one https origin every page is on;
 *   - the pages named verbatim: `urls`, a `template` expanded over its
 *     `values` (each value URL-encoded into one path segment, so a value
 *     cannot move the host or climb the path), and `follow.from`;
 *   - `pattern`: a glob a FOLLOWED link must match to be visited.
 * A link found on a page is visited only when it is on the origin and
 * matches the pattern, so a page cannot steer the crawler to a URL that
 * carries data out — the reason browser navigation is an act at all.
 *
 * "Learning" is `inferCrawlPattern`: from two or more example URLs it
 * works out the pattern (and, when exactly one path segment varies, the
 * template and its values), so an agent that has read a couple of pages
 * by hand can hand the rest to one crawl and save the result as a recipe.
 *
 * Pure and I/O-free, like the rest of this package: the worker runs the
 * plan (apps/worker-sandbox), the web app validates it before staging.
 */

/** Pages one crawl may visit. */
export const CRAWL_MAX_PAGES = 200;
/** Pages a crawl visits when the call does not say. */
export const CRAWL_DEFAULT_PAGES = 50;
/** How deep `follow` may go from its start pages. */
export const CRAWL_MAX_DEPTH = 3;
/** Values one template may expand. */
export const CRAWL_MAX_TEMPLATE_VALUES = CRAWL_MAX_PAGES;
/** Longest template value: one path segment, not a path. */
export const CRAWL_MAX_VALUE_CHARS = 200;
/** Pause between page loads, so a crawl is a polite reader, not a burst. */
export const CRAWL_PAGE_DELAY_MS = 500;
/** Page text kept per crawled page (tables are kept separately, as rows). */
export const CRAWL_PAGE_TEXT_MAX_CHARS = 60_000;
/** Tables kept per page, and rows kept per table. */
export const CRAWL_MAX_TABLES = 20;
export const CRAWL_MAX_TABLE_ROWS = 1_000;
/** Longest pattern a recipe may carry. */
export const CRAWL_MAX_PATTERN_CHARS = 500;

/** Which part of a page is kept: its `<main>` landmark, the whole page, or main when it has one. */
export type CrawlRegion = 'auto' | 'main' | 'page';

export interface CrawlRecipe {
  /** The https origin every page is on, e.g. "https://hl7-definition.caristix.com". */
  origin: string;
  /**
   * What a followed link's path (and query) must match: `*` is any run of
   * characters within one path segment, `**` any run across segments.
   * "/v2/HL7v2.3/Segments/*" matches every segment page and nothing deeper.
   */
  pattern: string;
  /** Pages named outright. */
  urls?: string[];
  /** A URL with one `{value}` placeholder, visited once per value. */
  template?: { url: string; values: string[] };
  /** Start pages whose in-pattern links are followed, up to `depth` links away. */
  follow?: { from: string[]; depth: number };
  region: CrawlRegion;
  maxPages: number;
}

export type CrawlPlanResult =
  { ok: true; recipe: CrawlRecipe; seeds: string[] } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? value : null;
}

/** A URL as the crawler keys it: no fragment, and nothing else changed. */
export function normalizeCrawlUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  url.hash = '';
  return url.toString();
}

/** The origin a recipe names, or null when it is not a bare https origin. */
function originOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.origin;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** A glob over path + query, as a RegExp anchored at both ends. */
export function crawlPatternRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/?#]*';
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/** Whether a followed link may be visited: on the origin, and matching the pattern. */
export function inCrawlScope(
  url: string,
  recipe: Pick<CrawlRecipe, 'origin' | 'pattern'>
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== recipe.origin || parsed.username || parsed.password) return false;
  return crawlPatternRegExp(recipe.pattern).test(`${parsed.pathname}${parsed.search}`);
}

/** The template's URLs, each value encoded into the single segment it fills. */
export function expandCrawlTemplate(template: { url: string; values: string[] }): string[] {
  return template.values.map((value) => template.url.replace('{value}', encodeURIComponent(value)));
}

/**
 * Validate a crawl call and work out its seeds — the pages it names
 * outright, in order, deduplicated. Every seed must be on the origin.
 */
export function planCrawl(input: unknown): CrawlPlanResult {
  if (!isRecord(input)) return { ok: false, error: 'A crawl needs an origin and a pattern.' };
  const origin = typeof input.origin === 'string' ? originOf(input.origin.trim()) : null;
  if (!origin) {
    return { ok: false, error: 'origin must be an https origin, like "https://example.com".' };
  }
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
  if (!pattern.startsWith('/') || pattern.length > CRAWL_MAX_PATTERN_CHARS) {
    return {
      ok: false,
      error:
        'pattern must be a path glob starting with "/", like "/docs/*" (at most 500 characters).',
    };
  }

  const urls = stringList(input.urls);
  if (urls === null) return { ok: false, error: 'urls must be a list of URLs.' };

  let template: CrawlRecipe['template'];
  if (input.template !== undefined) {
    const raw = input.template;
    const values = isRecord(raw) ? stringList(raw.values) : null;
    if (!isRecord(raw) || typeof raw.url !== 'string' || values === null) {
      return { ok: false, error: 'template needs a url with "{value}" and a list of values.' };
    }
    if (raw.url.split('{value}').length !== 2) {
      return { ok: false, error: 'template.url must contain "{value}" exactly once.' };
    }
    if (values.length > CRAWL_MAX_TEMPLATE_VALUES) {
      return { ok: false, error: `A template takes at most ${CRAWL_MAX_TEMPLATE_VALUES} values.` };
    }
    const tooLong = values.find((value) => !value || value.length > CRAWL_MAX_VALUE_CHARS);
    if (tooLong !== undefined) {
      return { ok: false, error: 'Each template value must be 1 to 200 characters.' };
    }
    template = { url: raw.url, values: [...new Set(values)] };
  }

  let follow: CrawlRecipe['follow'];
  if (input.follow !== undefined) {
    const raw = input.follow;
    const from = isRecord(raw) ? stringList(raw.from) : null;
    if (!isRecord(raw) || from === null || from.length === 0) {
      return { ok: false, error: 'follow needs from: the start pages whose links are followed.' };
    }
    const depth = typeof raw.depth === 'number' ? Math.floor(raw.depth) : 1;
    if (depth < 1 || depth > CRAWL_MAX_DEPTH) {
      return { ok: false, error: `follow.depth must be 1 to ${CRAWL_MAX_DEPTH}.` };
    }
    follow = { from, depth };
  }

  const named = [
    ...urls,
    ...(template ? expandCrawlTemplate(template) : []),
    ...(follow ? follow.from : []),
  ];
  if (named.length === 0) {
    return { ok: false, error: 'Name the pages to crawl: urls, a template, or follow.from.' };
  }
  const seeds: string[] = [];
  for (const raw of named) {
    const url = normalizeCrawlUrl(raw);
    if (!url || new URL(url).origin !== origin) {
      return { ok: false, error: `"${raw}" is not a URL on ${origin}.` };
    }
    if (!seeds.includes(url)) seeds.push(url);
  }

  const region: CrawlRegion =
    input.region === 'main' || input.region === 'page' ? input.region : 'auto';
  // Unsaid, a crawl covers the pages it names (a following crawl, the
  // default); what does not fit is left for the next crawl to resume.
  const requested = typeof input.maxPages === 'number' ? Math.floor(input.maxPages) : 0;
  const maxPages = Math.min(
    CRAWL_MAX_PAGES,
    requested > 0 ? requested : follow ? CRAWL_DEFAULT_PAGES : seeds.length
  );
  return {
    ok: true,
    recipe: {
      origin,
      pattern,
      ...(urls.length > 0 ? { urls } : {}),
      ...(template ? { template } : {}),
      ...(follow ? { follow } : {}),
      region,
      maxPages,
    },
    seeds,
  };
}

export type InferredCrawlPattern =
  | {
      ok: true;
      origin: string;
      pattern: string;
      /** When exactly one path segment varies: the template and the examples' values. */
      template: { url: string; values: string[] } | null;
    }
  | { ok: false; error: string };

/**
 * Learn a crawl's scope from example pages: the path segments the examples
 * share are kept, the ones that differ become `*`; examples of different
 * depths keep their shared prefix and end in `/**`. Query strings must
 * agree, or the pattern drops them for `*` on their values.
 */
export function inferCrawlPattern(examples: readonly string[]): InferredCrawlPattern {
  if (examples.length < 2) return { ok: false, error: 'Give at least two example URLs.' };
  const parsed: URL[] = [];
  for (const raw of examples) {
    const url = normalizeCrawlUrl(raw);
    if (!url) return { ok: false, error: `"${raw}" is not a URL.` };
    parsed.push(new URL(url));
  }
  const origin = parsed[0].origin;
  if (parsed[0].protocol !== 'https:' || parsed.some((url) => url.origin !== origin)) {
    return { ok: false, error: 'The examples must all be on the same https origin.' };
  }

  const paths = parsed.map((url) => url.pathname.split('/').slice(1));
  const sameDepth = paths.every((path) => path.length === paths[0].length);
  let segments: string[];
  if (sameDepth) {
    segments = paths[0].map((segment, index) =>
      paths.every((path) => path[index] === segment) ? segment : '*'
    );
  } else {
    const shortest = Math.min(...paths.map((path) => path.length));
    const shared: string[] = [];
    for (let index = 0; index < shortest; index += 1) {
      if (!paths.every((path) => path[index] === paths[0][index])) break;
      shared.push(paths[0][index]);
    }
    segments = [...shared, '**'];
  }

  const searches = parsed.map((url) => url.search);
  const search = searches.every((value) => value === searches[0])
    ? searches[0]
    : querySkeleton(parsed);
  const pattern = `/${segments.join('/')}${search}`;

  const varying = segments.flatMap((segment, index) => (segment === '*' ? [index] : []));
  const template =
    sameDepth && varying.length === 1 && searches.every((value) => value === searches[0])
      ? {
          url: `${origin}/${paths[0].map((segment, index) => (index === varying[0] ? '{value}' : segment)).join('/')}${searches[0]}`,
          values: paths.map((path) => decodeURIComponent(path[varying[0]])),
        }
      : null;
  return { ok: true, origin, pattern, template };
}

/** "?id=*&tab=*" — the examples' query keys in order, every value a wildcard. */
function querySkeleton(urls: readonly URL[]): string {
  const keys = [...urls[0].searchParams.keys()];
  return keys.length > 0 ? `?${keys.map((key) => `${encodeURIComponent(key)}=*`).join('&')}` : '**';
}

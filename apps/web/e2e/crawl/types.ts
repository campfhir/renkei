import { expect, type APIRequestContext } from '@playwright/test';
import type { Person } from '../support/person';

/**
 * What a page's `stage` gets: the crawl's signed-in person (an operator),
 * a request context carrying their cookie — the routes the UI itself
 * calls answer it as they would the browser — a tag no other test uses,
 * and `cleanup`, for undoing what is organization-wide through the UI's
 * own delete routes once the page has been checked.
 */
export interface CrawlStage {
  person: Person;
  /** Carries the person's cookie: the routes answer it as they would their browser. */
  api: APIRequestContext;
  /** Carries no cookie: for acting as somebody else (`person.headers`, or another person's). */
  request: APIRequestContext;
  /** Unique to this test: put it in the name of anything organization-wide. */
  tag: string;
  cleanup(undo: () => Promise<void>): void;
}

/**
 * One page the crawl visits (../crawl.spec.ts). A page whose data the UI
 * can create stages it through the app's REST routes (`stage`) and names
 * something only that data puts on screen (`expectText`), so a page that
 * rendered without reading its rows fails even if it reached for nothing.
 * A page whose data only a background process or a vendor produces
 * renders its empty state, which `expectText` names instead.
 */
export interface CrawlPage {
  /** The test's name, and the URL unless `stage` answers one (a page with ids in it). */
  path: string;
  /** Stage the page's data through the app's routes; answer the URL when it has ids in it. */
  stage?: (stage: CrawlStage) => Promise<string | void>;
  /** Visible once the page rendered its data (or its empty state). */
  expectText?: string | RegExp;
}

/** POST/PUT/PATCH a JSON body as the crawl's person and answer the parsed reply, failing on a non-2xx. */
export async function send(
  api: APIRequestContext,
  method: 'post' | 'put' | 'patch',
  url: string,
  data: unknown
): Promise<Record<string, unknown>> {
  const response = await api[method](url, { data });
  const text = await response.text();
  expect(response.ok(), `${method.toUpperCase()} ${url}: ${text}`).toBe(true);
  const body: unknown = text ? JSON.parse(text) : {};
  return typeof body === 'object' && body !== null ? { ...body } : {};
}

/** A string field of a reply (an id the route answered), failing when it is missing. */
export function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new Error(`expected "${key}" in ${JSON.stringify(body)}`);
  return value;
}

/** DELETE as the crawl's person, failing on a non-2xx. */
export async function remove(api: APIRequestContext, url: string): Promise<void> {
  const response = await api.delete(url);
  expect(response.ok(), `DELETE ${url}: ${await response.text()}`).toBe(true);
}

/** One agent of the crawl's person, as the builder's Save makes it (on, with an API trigger). */
export async function agentOf(
  api: APIRequestContext,
  name: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const created = await send(api, 'post', '/api/agents', {
    name,
    instructions: 'Crawl instructions line.',
    tools: [],
    triggers: [{ draft: { kind: 'api', inputs: [] }, enabled: true }],
    enabled: true,
    ...extra,
  });
  return field(created, 'agentId');
}

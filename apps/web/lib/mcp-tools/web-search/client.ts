/**
 * One call to the Responses API with the built-in `web_search` tool — the
 * wire shape Azure AI Foundry documents (and OpenAI's own surface shares):
 *
 *   POST {baseUrl}/responses
 *   { model, input, tools: [{ type: 'web_search', user_location?, filters? }] }
 *
 * The answer's `output` array is parsed BY TYPE, never by position — a
 * reasoning model puts a `reasoning` item first, and a model that decided
 * not to search omits the `web_search_call` item altogether. Both headers
 * are sent (Bearer and api-key): OpenAI reads the first, classic Azure
 * surfaces the second, and each ignores the other — the same rule as
 * packages/agent-llm's OpenAI adapter, for the same reason.
 *
 * Dependency-free on purpose (plain fetch, injected for tests), so the tool
 * module can be unit-tested without a network and this file can be read as
 * the complete contract with the provider.
 */

import type { WebSearchConfig, WebSearchLocation } from './config';

/** A search can be agentic (several searches, page opens) — well past the 15s read budget. */
export const WEB_SEARCH_TIMEOUT_MS = 90_000;

export interface WebSearchRequest {
  query: string;
  /** Overrides the org's configured location for this one search. */
  location?: WebSearchLocation | null;
  /** Already intersected with the org allowlist by the caller. */
  allowedDomains?: string[];
  /** ISO date the model is told is "today", so "latest" means latest. */
  today?: string;
}

export interface WebSearchCitation {
  url: string;
  title: string | null;
}

export interface WebSearchResult {
  /** The grounded answer text, citations inline where the model put them. */
  text: string;
  /** Distinct cited URLs, in first-appearance order. */
  citations: WebSearchCitation[];
  /** The queries the tool actually ran, in order. */
  queries: string[];
  /** Source URLs the search consulted (only when the provider returns them). */
  sources: string[];
  /** False when the model answered without calling the tool at all. */
  searched: boolean;
  /** The provider's status when it was not `completed` (e.g. incomplete). */
  status: string | null;
}

export type WebSearchErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'invalid_request'
  | 'timeout'
  | 'network'
  | 'provider_error';

export interface WebSearchError {
  kind: WebSearchErrorKind;
  message: string;
}

export type WebSearchOutcome =
  { ok: true; val: WebSearchResult } | { ok: false; error: WebSearchError };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Tolerate a pasted FULL endpoint: the base may already end in /responses
 * (or the chat surface's path, copied from the LLM-models page), and the
 * client appends /responses itself.
 */
export function responsesEndpoint(config: Pick<WebSearchConfig, 'baseUrl' | 'apiVersion'>): string {
  const base = config.baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(responses|chat\/completions)$/, '');
  const version = config.apiVersion ? `?api-version=${encodeURIComponent(config.apiVersion)}` : '';
  return `${base}/responses${version}`;
}

/** The request body, exported so a test can pin the wire shape. */
export function buildRequestBody(
  config: WebSearchConfig,
  request: WebSearchRequest
): Record<string, unknown> {
  const location = request.location ?? config.userLocation;
  const allowed = request.allowedDomains ?? config.allowedDomains;
  const filters: Record<string, unknown> = {};
  if (allowed.length > 0) filters.allowed_domains = allowed;
  if (config.blockedDomains.length > 0) filters.blocked_domains = config.blockedDomains;

  const tool: Record<string, unknown> = { type: 'web_search' };
  if (location) tool.user_location = { type: 'approximate', ...location };
  if (Object.keys(filters).length > 0) tool.filters = filters;

  const today = request.today ?? new Date().toISOString().slice(0, 10);
  return {
    model: config.model,
    ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
    instructions:
      `Today is ${today}. Search the web to answer the user's query — always call the ` +
      'web_search tool rather than answering from memory. Reply with a concise, factual ' +
      'summary of what the sources say, in the order of relevance, with a citation for ' +
      'every claim. Say plainly when the sources disagree or when nothing relevant was found.',
    input: request.query,
    tools: [tool],
    tool_choice: 'auto',
    // Sources ride on the web_search_call item when the surface supports
    // the include; a surface that does not simply omits them.
    include: ['web_search_call.action.sources'],
  };
}

function errorKindOf(status: number, body: string): WebSearchErrorKind {
  if (status === 401 || status === 403) return 'auth';
  // On Azure a 404 means "no such deployment" — retrying never fixes it.
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 413 || status === 422) return 'invalid_request';
  if (/invalid[_ ]api[_ ]key|incorrect api key|unauthorized/i.test(body)) return 'auth';
  return 'provider_error';
}

/** The provider's own error message out of a JSON error body, else the raw text. */
function providerMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === 'string') return error.message;
      if (typeof error === 'string') return error;
      if (typeof parsed.message === 'string') return parsed.message;
    }
  } catch {
    // Not JSON — the raw text is the message.
  }
  return body.slice(0, 500);
}

/** The response's `output` array → the parts a caller renders. */
export function parseResponseOutput(raw: unknown): WebSearchResult {
  const payload: { output?: unknown; status?: unknown } = isRecord(raw) ? raw : {};
  const texts: string[] = [];
  const citations: WebSearchCitation[] = [];
  const seenUrls = new Set<string>();
  const queries: string[] = [];
  const sources: string[] = [];
  let searched = false;

  const addCitation = (url: unknown, title: unknown) => {
    if (typeof url !== 'string' || !url || seenUrls.has(url)) return;
    seenUrls.add(url);
    citations.push({ url, title: typeof title === 'string' && title.trim() ? title : null });
  };

  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!isRecord(item)) continue;
    if (item.type === 'web_search_call') {
      searched = true;
      const action = isRecord(item.action) ? item.action : {};
      if (typeof action.query === 'string' && action.query.trim()) queries.push(action.query);
      for (const source of Array.isArray(action.sources) ? action.sources : []) {
        const url = isRecord(source) ? source.url : undefined;
        if (typeof url === 'string' && url && !sources.includes(url)) sources.push(url);
      }
      continue;
    }
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== 'output_text') continue;
      if (typeof part.text === 'string' && part.text) texts.push(part.text);
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (!isRecord(annotation) || annotation.type !== 'url_citation') continue;
        addCitation(annotation.url, annotation.title);
      }
    }
  }

  return {
    text: texts.join('\n\n'),
    citations,
    queries,
    sources,
    searched,
    status:
      typeof payload.status === 'string' && payload.status !== 'completed' ? payload.status : null,
  };
}

export async function runWebSearch(
  config: WebSearchConfig,
  request: WebSearchRequest,
  fetchImpl: FetchLike = fetch
): Promise<WebSearchOutcome> {
  const url = responsesEndpoint(config);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        'api-key': config.apiKey,
      },
      body: JSON.stringify(buildRequestBody(config, request)),
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      error: {
        kind: timedOut ? 'timeout' : 'network',
        message: timedOut
          ? `The web search did not answer within ${WEB_SEARCH_TIMEOUT_MS / 1000}s.`
          : `Could not reach the web-search endpoint: ${
              error instanceof Error ? error.message : String(error)
            }`,
      },
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      error: {
        kind: errorKindOf(response.status, body),
        message: `Web-search endpoint ${response.status}: ${providerMessage(body)}`,
      },
    };
  }

  const raw: unknown = await response.json().catch(() => null);
  // A 200 can still carry an error object (the streaming-style shape).
  if (isRecord(raw) && isRecord(raw.error) && typeof raw.error.message === 'string') {
    return {
      ok: false,
      error: { kind: 'provider_error', message: `Web-search endpoint error: ${raw.error.message}` },
    };
  }
  return { ok: true, val: parseResponseOutput(raw) };
}

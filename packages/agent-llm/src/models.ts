/**
 * What models a credential can actually reach — the provider's own Models
 * API, spoken with the SAME conventions as the completion adapters (plain
 * fetch, the same base-URL tolerance, the same auth-header rules per host).
 * Diverging here would mean a key that runs completions fine but cannot
 * list models, which reads as a broken key to the admin staring at it.
 *
 * This exists so one credential can serve many model rows: the admin page
 * asks a connection "what do you offer?" and the person picks from the
 * answer, instead of retyping model ids from a provider's docs — or worse,
 * creating a connection per model to find out which ids work.
 *
 * The list is returned as the provider sent it, unfiltered: OpenAI's
 * includes embeddings and image models, and pruning them here would need a
 * name-pattern list that goes stale the week after it ships. The picker is
 * an aid, not a gate — the model field stays free-text.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { looksLikeCredentialFailure } from './contract';
import type { Result } from '@campfhir/safe-functions/types';
import type { LlmErrorKind } from './contract';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
/** Interactive: someone clicked a button and is watching a spinner. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Anthropic paginates; one page of 1000 is everything today, so a second
 *  page is already surprising and five is a runaway guard, not a limit. */
const MAX_PAGES = 5;

export interface AvailableModel {
  id: string;
  /** Anthropic sends one; the OpenAI dialect has no such field. */
  displayName: string | null;
}

export interface ListModelsConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string | null;
  /** Azure surfaces version routes with ?api-version=; null = omit. */
  apiVersion?: string | null;
}

export type ListModelsError = LlmErrorKind | 'unsupported_provider';

/** The same status→kind mapping the adapters use, body outranking status
 *  for credentials (the gateway-answers-503-for-a-bad-key case). */
function errorKindOf(status: number, body: string): LlmErrorKind {
  if (looksLikeCredentialFailure(body)) return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  if (status === 529 || status === 502 || status === 503 || status === 504) return 'overloaded';
  return 'provider_error';
}

async function getJson(
  url: string,
  headers: Record<string, string>
): Promise<Result<unknown, LlmErrorKind>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const kind: LlmErrorKind =
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
    return err(kind, { message: error instanceof Error ? error.message : String(error) });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return err(errorKindOf(response.status, text), {
      message: `Models endpoint ${response.status}: ${text.slice(0, 500)}`,
    });
  }
  const body: unknown = await response.json().catch(() => ({}));
  return ok(body);
}

/** data[] rows of either dialect → typed models, junk dropped not fatal. */
function modelsOf(body: unknown): AvailableModel[] {
  const payload: { data?: unknown } = typeof body === 'object' && body !== null ? body : {};
  if (!Array.isArray(payload.data)) return [];
  return payload.data.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row: { id?: unknown; display_name?: unknown } = entry;
    if (typeof row.id !== 'string' || !row.id) return [];
    return [
      {
        id: row.id,
        displayName: typeof row.display_name === 'string' ? row.display_name : null,
      },
    ];
  });
}

function withQuery(base: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString();
  return search ? `${base}?${search}` : base;
}

async function listAnthropicModels(
  config: ListModelsConfig
): Promise<Result<AvailableModel[], LlmErrorKind>> {
  // The same pasted-full-endpoint tolerance as the adapter, plus its own
  // endpoint: the stored base_url may end in /v1/messages (the adapter's
  // target) and must still answer here.
  const baseUrl = (config.baseUrl || ANTHROPIC_BASE_URL)
    .replace(/\/+$/, '')
    .replace(/\/v1\/(messages|models)$/, '');

  // The adapter's auth-header rules, verbatim — see anthropic.ts for why
  // Azure gets Bearer ALONE and Anthropic-direct x-api-key alone. A base
  // URL that does not parse is caught HERE: the adapter meets it inside
  // its fetch try-block, but this function reads the hostname first.
  let isAzure: boolean;
  try {
    isAzure = /\.azure\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return err('invalid_request' as const, { message: `Not a valid base URL: ${baseUrl}` });
  }
  const authHeaders: Record<string, string> = isAzure
    ? { authorization: `Bearer ${config.apiKey}` }
    : config.baseUrl
      ? { 'x-api-key': config.apiKey, authorization: `Bearer ${config.apiKey}` }
      : { 'x-api-key': config.apiKey };
  const headers = { ...authHeaders, 'anthropic-version': ANTHROPIC_VERSION };

  const models: AvailableModel[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = withQuery(`${baseUrl}/v1/models`, {
      limit: '1000',
      ...(afterId ? { after_id: afterId } : {}),
      ...(config.apiVersion ? { 'api-version': config.apiVersion } : {}),
    });
    const result = await getJson(url, headers);
    if (!result.ok) return result;
    models.push(...modelsOf(result.val));

    const payload: { has_more?: unknown; last_id?: unknown } =
      typeof result.val === 'object' && result.val !== null ? result.val : {};
    if (payload.has_more !== true || typeof payload.last_id !== 'string') break;
    afterId = payload.last_id;
  }
  return ok(models);
}

async function listOpenAiModels(
  config: ListModelsConfig
): Promise<Result<AvailableModel[], LlmErrorKind>> {
  const baseUrl = (config.baseUrl || OPENAI_BASE_URL)
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|models)$/, '');
  const url = withQuery(`${baseUrl}/models`, {
    ...(config.apiVersion ? { 'api-version': config.apiVersion } : {}),
  });
  // Both headers, same as the adapter: OpenAI reads the Bearer, classic
  // Azure surfaces read api-key, each ignores the other.
  const result = await getJson(url, {
    authorization: `Bearer ${config.apiKey}`,
    'api-key': config.apiKey,
  });
  if (!result.ok) return result;
  // This dialect's list is one unpaginated jumble in no useful order;
  // alphabetical is the only order a person can scan it in.
  return ok(modelsOf(result.val).sort((a, b) => a.id.localeCompare(b.id)));
}

export async function listAvailableModels(
  config: ListModelsConfig
): Promise<Result<AvailableModel[], ListModelsError>> {
  switch (config.provider) {
    case 'anthropic':
      return listAnthropicModels(config);
    case 'openai':
      return listOpenAiModels(config);
    default:
      return err('unsupported_provider' as const, {
        message: `No models listing for provider "${config.provider}"`,
      });
  }
}

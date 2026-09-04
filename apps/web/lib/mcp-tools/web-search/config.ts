/**
 * The web-search connector's configuration: one org-wide Azure OpenAI (or
 * OpenAI) Responses API endpoint whose built-in `web_search` tool answers
 * `web_search` calls. Stored as a `connector_configs` row like embeddings
 * and Mistral OCR — one endpoint, one deployment, one key, no per-user
 * sign-in — because the provider has nothing per-user to grant: every
 * search runs under the org's key, and the org's own settings (location,
 * domain lists) shape what comes back.
 *
 * Settings (inspectable jsonb) and secrets (sealed) keys, mirrored by the
 * admin route at app/api/admin/[slug]/connectors/web-search/route.ts:
 *   settings.baseUrl         the Responses surface's base: for Azure AI
 *                            Foundry https://{resource}.openai.azure.com/openai/v1
 *   settings.model           the DEPLOYMENT name on Azure (e.g. gpt-5.5)
 *   settings.apiVersion      optional ?api-version= for surfaces that demand it
 *   settings.reasoningEffort optional reasoning.effort (agentic search on
 *                            reasoning models; blank = the model's default)
 *   settings.userLocation    optional approximate location the results are
 *                            tuned to (country/city/region/timezone)
 *   settings.allowedDomains  optional allowlist — results come only from these
 *   settings.blockedDomains  optional blocklist
 *   secrets.apiKey           the resource's API key
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';

/** The connector key the web-search capability registers under. */
export const WEB_SEARCH_CONNECTOR = 'web-search';

/** Azure's own ceiling on the allowlist; the blocklist gets the same cap. */
export const MAX_DOMAIN_LIST = 100;

/** The reasoning.effort values the Responses API accepts. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export interface WebSearchLocation {
  /** Two-letter ISO 3166-1 country code. */
  country?: string;
  city?: string;
  region?: string;
  /** IANA time zone identifier. */
  timezone?: string;
}

export interface WebSearchConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiVersion: string | null;
  reasoningEffort: string | null;
  userLocation: WebSearchLocation | null;
  allowedDomains: string[];
  blockedDomains: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A domain as Azure wants it: bare host, no scheme, no path, lowercased.
 * Admins and models both paste URLs, so `https://www.who.int/news` becomes
 * `www.who.int`. Anything that is not a plausible hostname is dropped —
 * a malformed entry silently narrowing a search to nothing is worse than
 * ignoring it.
 */
export function normalizeDomain(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.replace(/[/?#].*$/, '');
  host = host.replace(/^\*\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return null;
  }
  return host;
}

/** A stored or submitted domain list: an array, or a newline/comma/space-separated string. */
export function parseDomainList(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const domain = normalizeDomain(entry);
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out.slice(0, MAX_DOMAIN_LIST);
}

/** True when `domain` is `allowed` itself or a subdomain of it. */
export function domainWithin(domain: string, allowed: string): boolean {
  return domain === allowed || domain.endsWith(`.${allowed}`);
}

/**
 * A location object from settings or a tool argument: only the four fields
 * the API knows, each a non-blank string; null when nothing usable is set.
 */
export function parseLocation(value: unknown): WebSearchLocation | null {
  if (!isRecord(value)) return null;
  const location: WebSearchLocation = {};
  const country = trimmedString(value.country);
  if (country && /^[A-Za-z]{2}$/.test(country)) location.country = country.toUpperCase();
  const city = trimmedString(value.city);
  if (city) location.city = city;
  const region = trimmedString(value.region);
  if (region) location.region = region;
  const timezone = trimmedString(value.timezone);
  if (timezone) location.timezone = timezone;
  return Object.keys(location).length > 0 ? location : null;
}

export function parseReasoningEffort(value: unknown): string | null {
  const effort = trimmedString(value);
  return effort && REASONING_EFFORTS.some((known) => known === effort) ? effort : null;
}

/**
 * The org's web-search configuration, or null when it is not provisioned,
 * disabled, or missing a required field — callers then register no tool.
 * Cached briefly through readConnectorConfigCached, same as every other
 * per-call connector lookup.
 */
export async function resolveWebSearchConfig(tenantId: string): Promise<WebSearchConfig | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return null;

  const configResult = await readConnectorConfigCached(
    tenantId,
    WEB_SEARCH_CONNECTOR,
    keyResult.val
  );
  if (!configResult.ok) return null;
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const baseUrl = trimmedString(config.settings.baseUrl);
  const model = trimmedString(config.settings.model);
  const apiKey = config.secrets.apiKey;
  if (!baseUrl || !model || !apiKey) return null;

  return {
    baseUrl,
    apiKey,
    model,
    apiVersion: trimmedString(config.settings.apiVersion),
    reasoningEffort: parseReasoningEffort(config.settings.reasoningEffort),
    userLocation: parseLocation(config.settings.userLocation),
    allowedDomains: parseDomainList(config.settings.allowedDomains),
    blockedDomains: parseDomainList(config.settings.blockedDomains),
  };
}

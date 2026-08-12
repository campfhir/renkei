/**
 * The minimal Atlassian HTTP surface shared by the worker's poller and the
 * web app's ACL verifiers.
 *
 * It lives in a package rather than under `apps/web/lib/mcp-tools/` because
 * the worker cannot import from the Next app, and both halves need the same
 * gateway shape. Deliberately NOT a full client — the rich Jira and
 * Confluence tool surfaces stay where they are; this is only what polling
 * and access verification need.
 *
 * Both products sit behind the same gateway host, differing only in the
 * product segment: `api.atlassian.com/ex/{jira,confluence}/{cloudId}`.
 */

export const ATLASSIAN_GATEWAY = 'https://api.atlassian.com/ex';

export type AtlassianProduct = 'jira' | 'confluence';

export interface AtlassianCall {
  product: AtlassianProduct;
  cloudId: string;
  accessToken: string;
  /** Path after the product/cloudId segment, e.g. '/rest/api/3/search/jql'. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  json?: unknown;
}

/**
 * Success carries the parsed body; failure carries the HTTP status as well
 * as a reason, because callers must distinguish "the user cannot see this"
 * (403/404 — a legitimate verifier answer) from "the call broke" (0/5xx —
 * worth retrying). Collapsing both into one error string is how a transient
 * outage silently becomes a permission denial.
 */
export type AtlassianResponse =
  { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string };

export async function atlassianFetch(call: AtlassianCall): Promise<AtlassianResponse> {
  const url = `${ATLASSIAN_GATEWAY}/${call.product}/${call.cloudId}${call.path}`;
  const body = call.json === undefined ? undefined : JSON.stringify(call.json);

  let response: Response;
  try {
    response = await fetch(url, {
      method: call.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${call.accessToken}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    return { ok: false, status: 0, error: 'could not reach api.atlassian.com' };
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: text.length > 500 ? `${text.slice(0, 500)}…` : text || response.statusText,
    };
  }

  if (!text) return { ok: true, body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: response.status, error: 'malformed JSON response' };
  }
  return {
    ok: true,
    // A top-level array (some v1 endpoints) is wrapped so the body is always
    // a record — callers reach for a named field either way.
    body: Array.isArray(parsed) ? { value: parsed } : rec(parsed),
  };
}

/** Array-typed field of a response body, filtered to objects. */
export function listOf(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const entries = body[key];
  return Array.isArray(entries)
    ? entries.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null
      )
    : [];
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A type predicate rather than an assertion — this repo bans `as` outright. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rec(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

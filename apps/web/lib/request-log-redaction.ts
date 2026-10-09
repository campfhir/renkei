/**
 * What of a request's query string the proxy may write to the log.
 *
 * The proxy logs one line per request, query string included, and those
 * lines persist in the logs table and ship to the log sink. A query string
 * is where credentials end up when a protocol has nowhere better: the
 * Bitbucket webhook's shared `?secret=`, OAuth's `code` and `state` on
 * every callback, Graph's `validationToken`, an upload slot's `token`. A
 * log reader (any tenant user, for their org's rows) could lift a live
 * credential from the line about the request that presented it.
 *
 * Two rules. Webhook deliveries log no query at all — a webhook's query is
 * either empty or a credential, and nothing diagnostic lives there. Every
 * other path keeps its query with the values of credential-shaped
 * parameters replaced by a marker, so the line still says WHICH parameters
 * arrived without saying what they held.
 */

/** Query parameters whose values are never logged, wherever they appear. */
export const REDACTED_QUERY_PARAMETERS: ReadonlySet<string> = new Set([
  'secret',
  'token',
  'code',
  'state',
  'validationtoken',
  'client_secret',
  'access_token',
  'refresh_token',
  'id_token',
]);

export const REDACTED_VALUE = '[redacted]';

/**
 * The query string to log for a request, or undefined when there is nothing
 * to log — no query, or a path whose query must never be logged.
 */
export function loggableQuery(pathname: string, search: string): string | undefined {
  if (!search || search === '?') return undefined;
  if (pathname.startsWith('/api/webhooks/')) return undefined;
  const params = new URLSearchParams(search);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (REDACTED_QUERY_PARAMETERS.has(key.toLowerCase())) {
      params.set(key, REDACTED_VALUE);
      changed = true;
    }
  }
  return changed ? `?${params.toString()}` : search;
}

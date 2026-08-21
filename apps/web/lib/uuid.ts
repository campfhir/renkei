/**
 * URL-segment uuid hygiene. Ids arrive in URLs that get pasted into chat and
 * docs, where autolinkers glue on trailing punctuation ("…/mcp/<uuid>." at a
 * sentence end) — and Postgres answers a 22P02 for the malformed cast, which
 * surfaces as a 500 on a request that deserves a plain 404.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * API path prefixes whose NEXT segment is a uuid the handler will bind into
 * a query. The proxy rejects malformed ones with a 404 before any handler
 * runs, so no route needs its own guard.
 */
const UUID_SEGMENT_PREFIXES = [
  '/api/mcp/',
  '/api/tenant/',
  '/api/microsoft/',
  '/api/webex/',
  '/api/zoom/',
  '/api/atlassian-jsm/',
  '/api/atlassian-confluence/',
  '/api/webhooks/microsoft/',
  '/api/webhooks/webex/',
  '/api/webhooks/zoom/',
  '/api/upload/',
] as const;

/** True when the path names one of the uuid-keyed API trees with a bad id. */
export function hasMalformedUuidSegment(pathname: string): boolean {
  for (const prefix of UUID_SEGMENT_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      const segment = pathname.slice(prefix.length).split('/')[0] ?? '';
      // /api/mcp/.well-known/* is a sibling tree, not a tenant id — but it
      // only exists UNDER a tenant (/api/mcp/<uuid>/.well-known), so a
      // non-uuid first segment is malformed for every listed prefix.
      return !isUuid(segment);
    }
  }
  return false;
}

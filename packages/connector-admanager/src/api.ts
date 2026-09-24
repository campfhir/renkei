/**
 * The ADManager Plus REST API's shape, as far as Renkei needs to know it:
 * how a base URL is normalized, which request paths are acceptable to
 * forward, and how a filter expression is built for the search/list
 * endpoints. Everything here is pure and dependency-free so it can run in
 * the worker (which forwards the requests), the web app's tools (which
 * phrase them), and client components alike, and be tested without a
 * server.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export function isHttpMethod(value: unknown): value is HttpMethod {
  return value === 'GET' || value === 'POST' || value === 'PATCH' || value === 'DELETE';
}

/**
 * Parse an operator-supplied server URL. HTTPS is required unless the
 * operator has explicitly recorded `allowInsecureHttp` — ADManager Plus's
 * own docs default to plain `http://<host>:8080`, but an authtoken is as
 * sensitive as a Mirth password, so sending one over plaintext must be a
 * decision, not a default. Credentials, query strings and fragments in
 * the URL are refused; the result is origin + path with no trailing
 * slash.
 */
export function parseBaseUrl(value: unknown, allowInsecureHttp: boolean): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  // Operators often paste the API root itself; the version segment is
  // added per request, so strip a trailing /api here rather than end up
  // at /api/api/v2/...
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return url.origin + path;
}

/**
 * The one path filter between a caller and the ADManager Plus server.
 * Paths are absolute API routes (`/api/v1/user/unlockUserAccount`,
 * `/api/v2/users`): never climbing, never a second URL, and never a query
 * string — query parameters travel separately so they are encoded
 * exactly once.
 */
export function validApiPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/api/')) return false;
  if (path.length > 2048) return false;
  if (path.includes('..') || path.includes('://') || path.startsWith('//')) return false;
  if (path.includes('?') || path.includes('#')) return false;
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code < 0x21 || code === 0x7f) return false;
  }
  return true;
}

/**
 * One clause of an ADManager Plus filter expression: `COLUMN op "value"`.
 * Quotes inside the value are escaped so a name like `O'Brien` cannot
 * break out of the clause.
 */
export function filterClause(
  column: string,
  op: 'eq' | 'ne' | 'co' | 'sw' | 'ew',
  value: string
): string {
  const escaped = value.replace(/"/g, '\\"');
  return `${column} ${op} "${escaped}"`;
}

/** Several clauses joined with `and`/`or`, parenthesized so precedence never surprises. */
export function combineFilters(clauses: readonly string[], join: 'and' | 'or' = 'and'): string {
  const nonEmpty = clauses.filter((clause) => clause.trim().length > 0);
  if (nonEmpty.length === 0) return '';
  if (nonEmpty.length === 1) return nonEmpty[0];
  return nonEmpty.map((clause) => `(${clause})`).join(` ${join} `);
}

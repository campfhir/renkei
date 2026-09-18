/**
 * Where a signed-out visitor comes back to after signing in.
 *
 * The tenant layout is the one place that sees every `/[slug]/*` request and
 * can turn a signed-out one into a redirect BEFORE any HTML streams — but a
 * layout is never told which page it is wrapping. The proxy fills that gap:
 * it copies the request's path and query into this header, and the layout
 * reads it back to build the sign-in return URL.
 *
 * Anything that becomes a redirect target has to be a same-origin path.
 * The proxy overwrites the header on every request it sees, so a client
 * cannot plant one, but the sign-in route also takes the target from a
 * query string anyone can author — so both run it through safeReturnPath
 * rather than trusting where it came from.
 */

export const PATHNAME_HEADER = 'x-renkei-pathname';

/**
 * The candidate when it is a path on this origin, null otherwise.
 *
 * `//host/…` and `/\host/…` are scheme-relative to a browser: `new URL('//evil',
 * origin)` resolves to `https://evil/`, which is the open redirect this
 * exists to close. An absolute URL, an empty string and a bare word all
 * fail too — the callers fall back to the tenant's home page.
 */
export function safeReturnPath(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  if (!candidate.startsWith('/')) return null;
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return null;
  return candidate;
}

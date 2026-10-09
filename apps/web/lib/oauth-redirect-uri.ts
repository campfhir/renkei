/**
 * Where an MCP client may have its authorization code sent.
 *
 * A redirect URI is the one place the authorization server hands a code to
 * a party it cannot see, so what counts as acceptable is decided here, once,
 * for both registration endpoints and the authorize endpoint:
 *
 * - `https:` anywhere — a hosted client (claude.ai's connector callback).
 * - `http:` only to the loopback interface — a native app listening on a
 *   port it opened (Claude Code, an editor), per RFC 8252 section 7.3. Any
 *   port matches a registered loopback URI, since such a client picks its
 *   port at run time.
 * - A private-use scheme (`cursor:`, `vscode:`) — a native app's own
 *   handler, which an attacker on the web has no way to receive.
 *
 * What is refused: plain `http:` to any other host (a code sent there is
 * readable by whoever runs that host and by anything on the path), schemes
 * the browser would execute or read locally, a fragment (RFC 6749 section
 * 3.1.2), and credentials in the URL.
 */

const EXECUTABLE_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'blob:',
  'vbscript:',
  'about:',
  'chrome:',
  'ws:',
  'wss:',
]);

/** Loopback hostnames as `URL.hostname` reports them (IPv6 keeps its brackets). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Why `uri` cannot be a redirect URI, or null when it can. The reason is
 * written for the registering client's developer, and never repeats the
 * value itself.
 */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0) return 'must be a string';
  if (uri.length > 2048) return 'is longer than 2048 characters';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.hash || uri.includes('#')) return 'must not carry a fragment';
  if (url.username || url.password) return 'must not carry credentials';
  if (EXECUTABLE_SCHEMES.has(url.protocol)) return `may not use the ${url.protocol} scheme`;
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return 'must use https, except on the loopback interface (localhost, 127.0.0.1, [::1])';
  }
  if (url.protocol === 'https:' && !url.hostname) return 'must name a host';
  return null;
}

/**
 * Whether `presented` is one of the client's registered redirect URIs:
 * byte-for-byte equal, or equal apart from the port when both are loopback
 * `http:` URIs (RFC 8252 section 7.3 — the client could not know its port
 * when it registered).
 */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let candidate: URL;
  try {
    candidate = new URL(presented);
  } catch {
    return false;
  }
  if (candidate.protocol !== 'http:' || !isLoopbackHost(candidate.hostname)) return false;
  return registered.some((entry) => {
    let known: URL;
    try {
      known = new URL(entry);
    } catch {
      return false;
    }
    return (
      known.protocol === 'http:' &&
      isLoopbackHost(known.hostname) &&
      known.hostname.toLowerCase() === candidate.hostname.toLowerCase() &&
      known.pathname === candidate.pathname &&
      known.search === candidate.search
    );
  });
}

/** The part of a redirect URI a person can judge on the consent page. */
export function describeRedirectTarget(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return isLoopbackHost(url.hostname) ? 'an application running on this computer' : url.host;
    }
    return `the ${url.protocol.slice(0, -1)} application on this computer`;
  } catch {
    return uri;
  }
}

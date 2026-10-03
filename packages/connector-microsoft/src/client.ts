/**
 * Minimal Microsoft Graph request helper, delegated-grant scoped. Every call
 * rides a per-user `AuthedFetch` from the grant lifecycle (the delegate
 * worker holds the token and attaches it) — this connector has no org
 * credential, so nothing here can see more than the user can.
 *
 * The helper accepts absolute https URLs untouched because delta and paging
 * continuations (`@odata.nextLink` / `@odata.deltaLink`) come back from Graph
 * as absolute URLs; rebasing them would corrupt their opaque tokens.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { AuthedFetch } from '@renkei/delegate-client';
import type { RequestLane } from '@renkei/rate-limit';
import { GRAPH_BASE_URL, REQUEST_TIMEOUT_MS, GateTimeoutError, graphFetch } from './fetch';

export { GRAPH_BASE_URL } from './fetch';

/** Options accepted alongside a standard RequestInit. */
export interface GraphRequestOptions {
  /** Defaults to 'background'; verifiers and MCP tools pass 'interactive'. */
  lane?: RequestLane;
  /**
   * Per-call ceiling override, for requests Graph is legitimately slow to
   * answer (delta pages of full mail bodies). The 15s default fits
   * interactive calls; a background sync page is worth waiting longer for
   * than it is worth failing, because a retry re-pays the same latency.
   */
  timeoutMs?: number;
  /**
   * Re-send a throttled (429/503) answer after its Retry-After. On by
   * default for idempotent methods; a POST must opt in — see fetch.ts.
   */
  retry?: boolean;
}

export async function graphRequest(
  auth: AuthedFetch,
  pathOrUrl: string,
  init?: RequestInit & GraphRequestOptions
): Promise<Result<unknown, 'GRAPH_API_ERROR'>> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_BASE_URL}${pathOrUrl}`;

  let response: Response;
  try {
    response = await graphFetch(auth, url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const busy = error instanceof GateTimeoutError;
    return err('GRAPH_API_ERROR' as const, {
      message: timedOut
        ? `Graph API timed out after ${init?.timeoutMs ?? REQUEST_TIMEOUT_MS}ms for ${url}`
        : busy
          ? `Graph API busy: too many requests in flight for this mailbox (${url})`
          : 'Graph API unreachable',
    });
  }

  if (!response.ok) {
    // The status rides on `cause` so callers with status-specific semantics
    // (a DELETE finding the object already gone) can tell 404 from the rest
    // without parsing the message.
    return err('GRAPH_API_ERROR' as const, {
      message: `Graph API ${response.status} for ${url}`,
      cause: response.status,
    });
  }

  // Deletes and some mutations answer 204 with no body.
  if (response.status === 204) return ok(null);

  const parsed: unknown = await response.json().catch(() => null);
  if (parsed === null) {
    return err('GRAPH_API_ERROR' as const, {
      message: `Graph API returned no JSON for ${url}`,
    });
  }
  return ok(parsed);
}

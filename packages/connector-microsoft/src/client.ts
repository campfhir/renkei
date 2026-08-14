/**
 * Minimal Microsoft Graph request helper, delegated-token scoped. Every call
 * carries a per-user access token from the grant lifecycle — this connector
 * has no org credential, so nothing here can see more than the user can.
 *
 * The helper accepts absolute https URLs untouched because delta and paging
 * continuations (`@odata.nextLink` / `@odata.deltaLink`) come back from Graph
 * as absolute URLs; rebasing them would corrupt their opaque tokens.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { LaneLimiter, type RequestLane } from '@renkei/rate-limit';

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
/**
 * Bounds every call out to Graph — see the identical comment in
 * connector-webex's client.ts.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Process-scoped, split by lane — see `LaneLimiter` in @renkei/rate-limit.
 *
 * Background bounds bursts from the subscription health sweep (many
 * tenants/grants) and from delta-sync paging. Interactive keeps a reserve for
 * work a person is waiting on — above all the SharePoint ACL check, which
 * runs inside the retrieval gate's 3s budget and whose $batch call must not
 * queue behind a sweep, since anything unverified by the deadline is withheld
 * and reads as a denial.
 */
const limiter = new LaneLimiter({
  interactive: { capacity: 20, refillPerSecond: 10 },
  background: { capacity: 5, refillPerSecond: 5 },
});

/** Options accepted alongside a standard RequestInit. */
export interface GraphRequestOptions {
  /** Defaults to 'background'; verifiers and MCP tools pass 'interactive'. */
  lane?: RequestLane;
}

export async function graphRequest(
  accessToken: string,
  pathOrUrl: string,
  init?: RequestInit & GraphRequestOptions
): Promise<Result<unknown, 'GRAPH_API_ERROR'>> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_BASE_URL}${pathOrUrl}`;

  await limiter.take(init?.lane);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init?.headers ?? {}),
      },
      // A caller-supplied signal (none today) still wins — theirs may carry
      // its own cancellation semantics we should not override.
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return err('GRAPH_API_ERROR' as const, {
      message: timedOut
        ? `Graph API timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`
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

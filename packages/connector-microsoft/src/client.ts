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

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

export async function graphRequest(
  accessToken: string,
  pathOrUrl: string,
  init?: RequestInit
): Promise<Result<unknown, 'GRAPH_API_ERROR'>> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_BASE_URL}${pathOrUrl}`;

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
    });
  } catch {
    return err('GRAPH_API_ERROR' as const, { message: 'Graph API unreachable' });
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

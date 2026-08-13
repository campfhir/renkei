/**
 * Delta-query sync rounds — Graph's incremental-sync protocol.
 *
 * A round starts from either an initial collection URL or a stored deltaLink,
 * pages through `@odata.nextLink` continuations, and ends on the
 * `@odata.deltaLink` that names the state token for the NEXT round. The links
 * are absolute, opaque URLs — they must be followed verbatim, never rebuilt
 * (which is why graphRequest passes absolute https URLs through untouched).
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { graphRequest } from './client';

export type DeltaKind = 'mail-inbox' | 'calendar' | 'todo';

export interface InitialDeltaOptions {
  /** Required for 'todo' — Graph has no delta over all lists at once. */
  listId?: string;
  /** Calendar window start; defaults to 30 days ago. */
  windowStart?: Date;
  /** Calendar window end; defaults to 180 days ahead. */
  windowEnd?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The URL that opens a brand-new delta series for a resource. Subsequent
 * rounds start from the previous round's deltaLink instead.
 */
export function initialDeltaUrl(kind: DeltaKind, opts?: InitialDeltaOptions): string {
  switch (kind) {
    case 'mail-inbox':
      return "/me/mailFolders('inbox')/messages/delta";
    case 'calendar': {
      // calendarView/delta requires a bounded window: recurring events are
      // expanded into occurrences, which is only finite over a closed range.
      const start = opts?.windowStart ?? new Date(Date.now() - 30 * DAY_MS);
      const end = opts?.windowEnd ?? new Date(Date.now() + 180 * DAY_MS);
      const query = new URLSearchParams({
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
      });
      return `/me/calendarView/delta?${query}`;
    }
    case 'todo': {
      if (!opts?.listId) {
        throw new Error('initialDeltaUrl: todo requires a listId');
      }
      return `/me/todo/lists/${encodeURIComponent(opts.listId)}/tasks/delta`;
    }
  }
}

/** More pages than this in one round means something is wrong upstream. */
const MAX_DELTA_PAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run one delta round: follow nextLinks up to the page cap, return the
 * accumulated items and the cursor for the next round. When Graph closed
 * the round, that cursor is the deltaLink; when the page cap tripped first,
 * it is the unfollowed nextLink — resumable exactly like a deltaLink, so
 * the caller continues the enumeration next round instead of restarting the
 * series (which, on a resource with more items than one round covers, would
 * re-fetch the same head forever). Both null means Graph produced neither —
 * only then should the caller restart from an initial URL.
 */
export async function runDeltaRound(
  accessToken: string,
  startUrl: string
): Promise<
  Result<{ items: unknown[]; deltaLink: string | null; nextLink: string | null }, 'GRAPH_API_ERROR'>
> {
  const items: unknown[] = [];
  let url: string | null = startUrl;
  let deltaLink: string | null = null;

  for (let page = 0; page < MAX_DELTA_PAGES && url !== null; page += 1) {
    const result: Result<unknown, 'GRAPH_API_ERROR'> = await graphRequest(accessToken, url, {
      // Mail bodies come back as HTML by default; text keeps the index clean.
      // Non-mail resources ignore the preference, so it is safe to send always.
      headers: { Prefer: 'outlook.body-content-type="text"' },
    });
    if (!result.ok) return result;

    const body = result.val;
    if (!isRecord(body)) {
      return err('GRAPH_API_ERROR' as const, { message: 'delta response was not an object' });
    }

    if (Array.isArray(body.value)) items.push(...body.value);

    const next = body['@odata.nextLink'];
    const delta = body['@odata.deltaLink'];
    if (typeof delta === 'string' && delta) {
      deltaLink = delta;
      url = null;
    } else if (typeof next === 'string' && next) {
      url = next;
    } else {
      url = null;
    }
  }

  return ok({ items, deltaLink, nextLink: deltaLink === null ? url : null });
}

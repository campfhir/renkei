/**
 * The `content_watches` read/write helpers shared by the Jira, Confluence
 * and SharePoint watch tools.
 *
 * A watch is a standing instruction — "keep this project/space/library
 * indexed" — owned by the user who created it, because the worker polls
 * with THAT user's grant. That ownership is the whole safety story: a watch
 * can only ever surface content its owner could already read, and when
 * their grant is revoked the polling simply stops.
 *
 * For SharePoint the ownership story stops one step short, and the
 * difference matters: a document library is shared, so what the owner can
 * read is NOT what every reader may read. Indexing is still bounded by the
 * watcher's access, but disclosure is decided per reader by the live ACL
 * gate at retrieval — never by this row.
 *
 * Nothing here calls a provider. Validating that the project, space or
 * library actually exists belongs to the connector's own tool, which
 * already has a client; this layer only owns the row.
 */

import { getDataStore } from '@renkei/db';

/**
 * Matches the `knowledge_chunks.provider` each poller writes, so the ACL
 * verifier for a chunk is found by the same key that produced it.
 */
export type WatchProvider = 'jira' | 'confluence' | 'sharepoint';
/** 'drive' covers both a SharePoint document library and a personal OneDrive: both are drives, and scope_key is the driveId either way. */
export type WatchScopeType = 'project' | 'space' | 'drive';

export interface WatchOwner {
  /** OIDC subject — the watch's owner, and the uniqueness key. */
  subject: string;
  /** The provider account whose grant the worker polls with. */
  accountId: string;
}

export interface WatchRecord {
  provider: string;
  scopeType: string;
  scopeKey: string;
  scopeLabel: string | null;
  enabled: boolean;
  lastSyncedAt: Date | null;
  lastRunItems: number;
  /** Cumulative items the SWEEP has read and enqueued. Not searchability. */
  totalItems: number;
  /**
   * Objects actually in the index and findable right now.
   *
   * Distinct from `totalItems`, and the distinction is not academic: the
   * sweep counts what it handed to the queue, so a watch can read "2,000
   * items, idle" while none of them are searchable because the embedding
   * backlog has not reached them. During a rebuild that gap is hours wide,
   * and reporting only the sweep's number makes a half-built index look
   * finished.
   */
  indexedObjects: number;
  /** Objects read but not yet embedded — the remaining work. */
  queuedObjects: number;
  syncStatus: string;
  lastError: string | null;
}

/** The metadata key each provider records its scope under. */
const SCOPE_METADATA_KEY: Record<string, string> = {
  jira: 'project',
  confluence: 'spaceId',
  sharepoint: 'scopeKey',
};

type WatchResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * The result shape the watch tools branch on. A store failure rejects, as a
 * query here always did; `ok: false` is kept for the callers' contract.
 */
async function guarded<T>(work: () => Promise<T>): Promise<WatchResult<T>> {
  return { ok: true, ...(await work()) };
}

/**
 * Create or re-enable a watch. Re-watching an existing scope is a no-op on
 * the cursor — deliberately, so a user who unwatches and re-watches does
 * not trigger a full re-index of a large space. A re-watch also clears a
 * stale failure, so the connectors page doesn't keep showing an error from
 * a grant problem the user just fixed.
 *
 * A fresh row for a scope some OTHER subject already indexed inherits that
 * row's cursor: the index already holds the scope's history, so starting
 * this watch from NULL would re-read an entire space to rebuild what is
 * already there. This is how a watch orphaned by a dead grant gets picked
 * up by the next person without the costly full re-read.
 */
export async function upsertWatch(
  owner: WatchOwner,
  provider: WatchProvider,
  scopeType: WatchScopeType,
  scopeKey: string,
  scopeLabel: string | null
): Promise<WatchResult<{ created: boolean }>> {
  return guarded(() =>
    getDataStore().contentWatches.watch(owner, { provider, scopeType, scopeKey, scopeLabel })
  );
}

/**
 * Rebind a scope's watch rows — whoever owns them — to the CALLER's live
 * grant, keeping every cursor.
 *
 * The stuck case this exists for: a watch whose owner's grant died (left
 * the org, token revoked, expired-grant sweep) fails every poll forever,
 * and because the uniqueness key includes the subject, another user
 * "adding" the same scope creates a SECOND watch with a NULL cursor — a
 * full re-read of the whole space, which is exactly the costly thing a
 * repair must avoid. Taking the existing rows over instead resumes
 * incremental polling from where they stopped. The rows are marked
 * never-synced, which puts them at the head of the sweep's
 * never-synced-first ordering — "repair" should visibly poll within
 * minutes, not wait out the org's normal cadence.
 *
 * Safe to point at someone else's watch because the caller's own access
 * was just proven against the provider (the route resolves the scope
 * before calling this), indexing runs under the caller's authority from
 * here on, and disclosure was never the watch's job — the read-time gate
 * decides that per reader.
 */
export async function repairWatch(
  owner: WatchOwner,
  provider: WatchProvider,
  scopeType: WatchScopeType,
  scopeKey: string
): Promise<WatchResult<{ repaired: number }>> {
  return guarded(async () => ({
    repaired: await getDataStore().contentWatches.repair(owner, {
      provider,
      scopeType,
      scopeKey,
    }),
  }));
}

/**
 * Stop polling a scope. This disables rather than deletes so the cursor
 * survives: re-watching later resumes from where it stopped instead of
 * re-reading the whole history. Already-indexed content stays searchable —
 * it is still gated live per read, so nothing leaks by keeping it.
 */
export async function disableWatch(
  owner: WatchOwner,
  provider: WatchProvider,
  scopeType: WatchScopeType,
  scopeKey: string
): Promise<WatchResult<{ found: boolean }>> {
  return guarded(async () => ({
    found:
      (await getDataStore().contentWatches.disable(owner.subject, {
        provider,
        scopeType,
        scopeKey,
      })) > 0,
  }));
}

export async function listWatches(
  owner: WatchOwner,
  provider: WatchProvider
): Promise<WatchResult<{ watches: WatchRecord[] }>> {
  return guarded(async () => {
    const store = getDataStore().contentWatches;
    const rows = await store.list(owner.subject, provider);

    // Two grouped reads for the whole list rather than two per watch.
    // Counted by OBJECT, not by chunk row: one issue becomes several
    // chunks, and "1,004 indexed" meaning chunks would not line up with
    // the page count an admin recognises.
    const counts = await store.objectCounts(provider, SCOPE_METADATA_KEY[provider] ?? 'project');
    const indexedByScope = new Map(counts.indexed.map((row) => [row.scope, row.objects]));
    const queuedByScope = new Map(counts.queued.map((row) => [row.scope, row.objects]));

    return {
      watches: rows.map((row) => ({
        ...row,
        indexedObjects: indexedByScope.get(row.scopeKey) ?? 0,
        queuedObjects: queuedByScope.get(row.scopeKey) ?? 0,
      })),
    };
  });
}

/** One watch as a line of tool output. */
export function watchLine(watch: WatchRecord): string {
  const label = watch.scopeLabel ? `${watch.scopeLabel} (${watch.scopeKey})` : watch.scopeKey;
  const synced = watch.lastSyncedAt
    ? `last synced ${new Date(watch.lastSyncedAt).toISOString()}`
    : 'never synced';
  const state = watch.enabled ? watch.syncStatus : 'paused';
  return (
    `${label} — ${state} — ${synced} — ${watch.totalItems} item(s) indexed` +
    (watch.lastError ? `\n    ⚠ ${watch.lastError}` : '')
  );
}

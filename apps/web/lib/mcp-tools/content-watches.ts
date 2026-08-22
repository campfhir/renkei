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

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';

/**
 * Matches the `knowledge_chunks.provider` each poller writes, so the ACL
 * verifier for a chunk is found by the same key that produced it.
 */
export type WatchProvider = 'jira' | 'confluence' | 'sharepoint';
/** 'drive' covers both a SharePoint document library and a personal OneDrive: both are drives, and scope_key is the driveId either way. */
export type WatchScopeType = 'project' | 'space' | 'drive';

export interface WatchOwner {
  tenantId: string;
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

/**
 * Create or re-enable a watch. Re-watching an existing scope is a no-op on
 * the cursor — deliberately, so a user who unwatches and re-watches does
 * not trigger a full re-index of a large space.
 */
export async function upsertWatch(
  owner: WatchOwner,
  provider: WatchProvider,
  scopeType: WatchScopeType,
  scopeKey: string,
  scopeLabel: string | null
): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return { ok: false, error: 'Database unavailable.' };

  const existing = await dbResult.val
    .selectFrom('content_watches')
    .select(['id', 'enabled'])
    .where('tenant_id', '=', owner.tenantId)
    .where('provider', '=', provider)
    .where('subject', '=', owner.subject)
    .where('scope_type', '=', scopeType)
    .where('scope_key', '=', scopeKey)
    .executeTakeFirst();

  if (existing) {
    await dbResult.val
      .updateTable('content_watches')
      .set({
        enabled: true,
        scope_label: scopeLabel,
        // A re-watch clears a stale failure so the connectors page doesn't
        // keep showing an error from a grant problem the user just fixed.
        last_error: null,
        sync_status: 'idle',
        account_id: owner.accountId,
        updated_at: sql<Date>`NOW()`,
      })
      .where('id', '=', existing.id)
      .execute();
    return { ok: true, created: !existing.enabled };
  }

  // A fresh row for a scope some OTHER subject already indexed inherits
  // that row's cursor: the index already holds the scope's history, so
  // starting this watch from NULL would re-read an entire space to rebuild
  // what is already there. This is how a watch orphaned by a dead grant
  // gets picked up by the next person without the costly full re-read.
  const sibling = await dbResult.val
    .selectFrom('content_watches')
    .select('cursor')
    .where('tenant_id', '=', owner.tenantId)
    .where('provider', '=', provider)
    .where('scope_type', '=', scopeType)
    .where('scope_key', '=', scopeKey)
    .where('cursor', 'is not', null)
    .orderBy('updated_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  await dbResult.val
    .insertInto('content_watches')
    .values({
      id: randomUUID(),
      tenant_id: owner.tenantId,
      provider,
      account_id: owner.accountId,
      subject: owner.subject,
      scope_type: scopeType,
      scope_key: scopeKey,
      scope_label: scopeLabel,
      cursor: sibling?.cursor ?? null,
    })
    .execute();
  return { ok: true, created: true };
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
 * incremental polling from where they stopped.
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
): Promise<{ ok: true; repaired: number } | { ok: false; error: string }> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return { ok: false, error: 'Database unavailable.' };

  const result = await dbResult.val
    .updateTable('content_watches')
    .set({
      subject: owner.subject,
      account_id: owner.accountId,
      enabled: true,
      last_error: null,
      sync_status: 'idle',
      // NULL puts the row at the head of the sweep's never-synced-first
      // ordering — "repair" should visibly poll within minutes, not wait
      // out the org's normal cadence. The cursor is deliberately untouched.
      last_synced_at: null,
      updated_at: sql<Date>`NOW()`,
    })
    .where('tenant_id', '=', owner.tenantId)
    .where('provider', '=', provider)
    .where('scope_type', '=', scopeType)
    .where('scope_key', '=', scopeKey)
    .executeTakeFirst();

  return { ok: true, repaired: Number(result.numUpdatedRows ?? 0) };
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
): Promise<{ ok: true; found: boolean } | { ok: false; error: string }> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return { ok: false, error: 'Database unavailable.' };

  const result = await dbResult.val
    .updateTable('content_watches')
    .set({ enabled: false, sync_status: 'idle', updated_at: sql<Date>`NOW()` })
    .where('tenant_id', '=', owner.tenantId)
    .where('provider', '=', provider)
    .where('subject', '=', owner.subject)
    .where('scope_type', '=', scopeType)
    .where('scope_key', '=', scopeKey)
    .where('enabled', '=', true)
    .executeTakeFirst();

  return { ok: true, found: Number(result.numUpdatedRows ?? 0) > 0 };
}

export async function listWatches(
  owner: WatchOwner,
  provider: WatchProvider
): Promise<{ ok: true; watches: WatchRecord[] } | { ok: false; error: string }> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return { ok: false, error: 'Database unavailable.' };

  const rows = await dbResult.val
    .selectFrom('content_watches')
    .select([
      'provider',
      'scope_type',
      'scope_key',
      'scope_label',
      'enabled',
      'last_synced_at',
      'last_run_items',
      'total_items',
      'sync_status',
      'last_error',
    ])
    .where('tenant_id', '=', owner.tenantId)
    .where('provider', '=', provider)
    .where('subject', '=', owner.subject)
    .orderBy('scope_key', 'asc')
    .execute();

  const metadataKey = SCOPE_METADATA_KEY[provider] ?? 'project';

  // Two grouped reads for the whole list rather than two per watch. Counted
  // by OBJECT, not by chunk row: one issue becomes several chunks, and "1,004
  // indexed" meaning chunks would not line up with the page count an admin
  // recognises.
  const indexed = await dbResult.val
    .selectFrom('knowledge_chunks')
    .select([
      sql<string>`metadata ->> ${metadataKey}`.as('scope'),
      sql<string>`count(DISTINCT split_part(ref_id, '#', 1))`.as('objects'),
    ])
    .where('tenant_id', '=', owner.tenantId)
    .where('provider', '=', provider)
    // GROUP BY the output ALIAS, never a repeat of the expression: each
    // `${metadataKey}` becomes its own bound parameter, so Postgres sees
    // `->> $2` against `->> $3`, calls them different expressions, and
    // rejects the query. Naming it once removes the possibility.
    .groupBy(sql`scope`)
    .execute();

  const queued = await dbResult.val
    .selectFrom('embedding_jobs')
    .select([
      sql<string>`payload -> 'metadata' ->> ${metadataKey}`.as('scope'),
      sql<string>`count(*)`.as('objects'),
    ])
    .where('tenant_id', '=', owner.tenantId)
    .where('status', '=', 'pending')
    .where(sql<boolean>`payload ->> 'provider' = ${provider}`)
    .groupBy(sql`scope`)
    .execute();

  const indexedByScope = new Map(indexed.map((row) => [row.scope, Number(row.objects)]));
  const queuedByScope = new Map(queued.map((row) => [row.scope, Number(row.objects)]));

  return {
    ok: true,
    watches: rows.map((row) => ({
      provider: row.provider,
      scopeType: row.scope_type,
      scopeKey: row.scope_key,
      scopeLabel: row.scope_label,
      enabled: row.enabled,
      lastSyncedAt: row.last_synced_at,
      lastRunItems: row.last_run_items,
      totalItems: row.total_items,
      indexedObjects: indexedByScope.get(row.scope_key) ?? 0,
      queuedObjects: queuedByScope.get(row.scope_key) ?? 0,
      syncStatus: row.sync_status,
      lastError: row.last_error,
    })),
  };
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

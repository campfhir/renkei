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
  totalItems: number;
  syncStatus: string;
  lastError: string | null;
}

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
    })
    .execute();
  return { ok: true, created: true };
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

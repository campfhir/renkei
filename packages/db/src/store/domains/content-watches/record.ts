import type { Selectable } from 'kysely';
import type { ContentWatches } from '../../../db.types';
import type { ContentWatchRecord, ContentWatchSyncState } from './types';

export function contentWatchFromRow(row: Selectable<ContentWatches>): ContentWatchRecord {
  return {
    id: row.id,
    provider: row.provider,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    scopeLabel: row.scope_label,
    accountId: row.account_id,
    enabled: row.enabled,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : null,
    lastRunItems: row.last_run_items,
    totalItems: row.total_items,
    syncStatus: row.sync_status,
    lastError: row.last_error,
  };
}

/** What a rebuild resets (updated_at aside, which each side stamps itself). */
export const REBUILD_RESET = {
  cursor: null,
  total_items: 0,
  last_run_items: 0,
  sync_status: 'syncing',
  last_error: null,
  // Null, not NOW(): the sweep treats never-synced watches as due
  // immediately, so the rebuild starts on the next pass rather than
  // waiting out a full interval.
  last_synced_at: null,
};

export function contentWatchSyncStateFromRow(row: {
  cursor: string | null;
  sync_status: string;
  last_synced_at: Date | null;
  last_run_items: number;
  total_items: number;
  last_error: string | null;
}): ContentWatchSyncState {
  return {
    cursor: row.cursor,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : null,
    lastRunItems: row.last_run_items,
    totalItems: row.total_items,
    lastError: row.last_error,
  };
}

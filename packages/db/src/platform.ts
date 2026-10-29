/**
 * What a process needs from the database around its data, not in it: the
 * log table's adapter, a boot-time "is there a data store to reach", and
 * the close at shutdown. Every caller used to hold the Kysely handle for
 * these three things alone; they live here so no caller ever does.
 */

import type { PostgresAdapter, PostgresAdapterOptions } from '@campfhir/bored-logs/adapters/psql';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { closeDatabase, getDatabase } from './client';
import { memoryDataStoreRequested } from './store/selection';

/** The bored-logs Postgres adapter's options, less the connection this package supplies. */
export type LogAdapterOptions = Omit<PostgresAdapterOptions, 'db'>;

/**
 * A bored-logs `PostgresAdapter` over this process's own connection: the
 * logs tables, batching and encryption exactly as `options` configure them.
 * DB_INIT_ERROR when there is no database to write to (no DATABASE_URL, or
 * the in-memory data store, which has no log table). The adapter module is
 * loaded on demand so this barrel stays free of it for edge bundles.
 */
export async function createLogAdapter(
  options: LogAdapterOptions
): Promise<Result<PostgresAdapter, 'DB_INIT_ERROR'>> {
  if (memoryDataStoreRequested()) {
    return err('DB_INIT_ERROR' as const, { message: 'the in-memory data store has no log table' });
  }
  const db = getDatabase();
  if (!db.ok) return db;
  const { PostgresAdapter: Adapter } = await import('@campfhir/bored-logs/adapters/psql');
  return ok(new Adapter({ ...options, db: db.val }));
}

/**
 * Whether this process has a data store to reach, without touching it: the
 * memory store always; Postgres when a connection is configured. The boot
 * check a worker makes before it starts consuming. (A configured database
 * that is down still passes, as it always did — the first query reports it,
 * and the loops back off and retry.)
 */
export function checkDataStore(): Result<void, 'DB_INIT_ERROR'> {
  if (memoryDataStoreRequested()) return ok();
  const db = getDatabase();
  return db.ok ? ok() : db;
}

/** Shutdown: end this process's database connections, if it opened any. */
export async function closeDataStore(): Promise<void> {
  await closeDatabase();
}

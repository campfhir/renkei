/**
 * @renkei/db — the single Postgres instance, shared by every process.
 *
 * Exposes the data store (getDataStore), the generated schema types and
 * the migration status. The connection itself never leaves this package:
 * the web app, the workers, their scripts and their tests read and write
 * through the store, so connection handling, SQL and schema knowledge live
 * in exactly one place.
 */

export { describeActor, describeAccountActor, resetActorCache, type Actor } from './actors';
export type * from './db.types';
// The data store: the seam pages and routes read through instead of
// querying directly, with a Postgres and an in-memory implementation held
// to one contract (store/types.ts says which areas are behind it).
export {
  getDataStore,
  getMemoryDataStore,
  registerDataStore,
  resetDataStore,
} from './store/registry';
export { MEMORY_DATA_STORE, memoryDataStoreRequested } from './store/selection';
export { createMemoryDataStore, type MemoryDataStore, type MemorySeed } from './store/memory';
export type { QueueSignal } from './store/memory/signals';
export {
  MemoryTables,
  MemoryStoreError,
  toJson,
  type Row,
  type NewRow,
  type TableName,
  type TableRows,
} from './store/memory/tables';
export { compareAsc, orderBy, like, page } from './store/memory/order';
// The knowledge search's metadata filter, compiled by the store's Postgres
// side and re-exported by @renkei/knowledge beside its query splitter.
export {
  compileMetadataFilter,
  metadataMatches,
  FREE_TEXT_KEY,
} from './store/domains/knowledge-chunks/metadata-filter';
export type * from './store/types';
// The migration runner is deliberately NOT re-exported here: it touches fs,
// path and process.cwd, which poisons this barrel for Next's edge-runtime
// analysis. The migrate CLI imports ./migrations/runner directly.
export { getMigrationStatus, EXPECTED_MIGRATIONS, MIGRATION_COMMAND } from './migrations/status';
// Boot and shutdown without the handle: the log table's adapter over this
// package's own connection, the boot-time reachability check, the close.
export {
  createLogAdapter,
  checkDataStore,
  closeDataStore,
  type LogAdapterOptions,
} from './platform';

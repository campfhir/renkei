/**
 * @renkei/db — the single Postgres instance, shared by every process.
 *
 * Exposes the Kysely client, the generated schema types, and the migration
 * API. Web routes, the worker, and the migrate CLI all come through here so
 * connection handling and schema knowledge live in exactly one place.
 */

export {
  initDatabase,
  getDatabase,
  getPool,
  closeDatabase,
  directDatabaseCalls,
  resetDirectDatabaseCalls,
} from './client';
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
export {
  MemoryTables,
  MemoryStoreError,
  type Row,
  type NewRow,
  type TableName,
  type TableRows,
} from './store/memory/tables';
export { compareAsc, orderBy, like, page } from './store/memory/order';
export { createPostgresDataStore } from './store/postgres';
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

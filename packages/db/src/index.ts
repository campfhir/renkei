/**
 * @renkei/db — the single Postgres instance, shared by every process.
 *
 * Exposes the Kysely client, the generated schema types, and the migration
 * API. Web routes, the worker, and the migrate CLI all come through here so
 * connection handling and schema knowledge live in exactly one place.
 */

export { initDatabase, getDatabase, getPool, closeDatabase } from './client';
export { describeActor, describeAccountActor, resetActorCache, type Actor } from './actors';
export type * from './db.types';
// The migration runner is deliberately NOT re-exported here: it touches fs,
// path and process.cwd, which poisons this barrel for Next's edge-runtime
// analysis. The migrate CLI imports ./migrations/runner directly.
export { getMigrationStatus, EXPECTED_MIGRATIONS, MIGRATION_COMMAND } from './migrations/status';

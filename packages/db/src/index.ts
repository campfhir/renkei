/**
 * @renkei/db — the single Postgres instance, shared by every process.
 *
 * Exposes the Kysely client, the generated schema types, and the migration
 * API. Web routes, the worker, and the migrate CLI all come through here so
 * connection handling and schema knowledge live in exactly one place.
 */

export { initDatabase, getDatabase, getPool, closeDatabase } from './client';
export type * from './db.types';
export { runMigrations } from './migrations/runner';
export { getMigrationStatus, EXPECTED_MIGRATIONS, MIGRATION_COMMAND } from './migrations/status';

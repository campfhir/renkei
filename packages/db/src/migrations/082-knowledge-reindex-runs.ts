import { Kysely, sql } from 'kysely';

/**
 * The record of an admin-started knowledge reindex (the buttons on the
 * Embeddings connector card): what kind, how far it got, how it ended.
 *
 * A reindex runs as a chain of short `knowledge/reindex.batch` jobs on the
 * embedding queue rather than one long request or one long job — a
 * mailbox's worth of rows would outlive any delivery lease, and the web
 * process must never call an embeddings endpoint. The chain needs somewhere
 * to keep its cursor and its tallies between links, and the admin needs
 * something to read progress from: this row is both.
 *
 * `status`: queued → running → done | failed. A failed run keeps its
 * `last_error`; the next click starts a fresh run, which is safe because
 * every kind is idempotent (lexical and keywords touch only rows still
 * lacking their value; embed recomputes what it recomputed).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('knowledge_reindex_runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    // 'lexical' | 'embed' | 'keywords' — packages/knowledge/src/reindex.ts.
    .addColumn('kind', 'varchar(16)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('queued'))
    .addColumn('processed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('skipped', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('failed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('cursor', 'text')
    .addColumn('last_error', 'text')
    .addColumn('requested_by', 'varchar(255)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .execute();

  await db.schema
    .createIndex('idx_knowledge_reindex_runs_tenant')
    .on('knowledge_reindex_runs')
    .columns(['tenant_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('knowledge_reindex_runs').execute();
}

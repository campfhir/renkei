import { Kysely, sql } from 'kysely';

/**
 * The knowledge layer's store (RENKEI.md Decision #11): pgvector inside the
 * single Postgres instance, vectors joined directly to relational metadata.
 *
 * Every chunk carries a durable reference back to its source object —
 * (provider, ref_id) — because retrieval is two steps: this table only
 * PROPOSES candidates, and nothing is disclosed until the requesting user's
 * access to each candidate is verified live against the provider (Decisions
 * #14/#18). Nothing here is authorization.
 *
 * The embedding column is untyped `vector` on purpose: the embedding model
 * (and so the dimension) is org configuration, not schema. Retrieval is an
 * exact scan for now — an ANN index requires a fixed dimension and can be
 * added when volume demands it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);

  await db.schema
    .createTable('knowledge_chunks')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    // The SourceRef the verifyAccess gate checks: which provider, which object.
    .addColumn('provider', 'varchar(64)', (col) => col.notNull())
    .addColumn('ref_id', 'varchar(255)', (col) => col.notNull())
    // Provider-shaped locator detail (roomId, personEmail, timestamps, …),
    // candidate-narrowing and display only — never authorization.
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('embedding', sql`vector`, (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // One chunk per source object per tenant: re-ingesting replaces, not duplicates.
  await db.schema
    .createIndex('idx_knowledge_chunks_ref')
    .unique()
    .on('knowledge_chunks')
    .columns(['tenant_id', 'provider', 'ref_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('knowledge_chunks').execute();
}

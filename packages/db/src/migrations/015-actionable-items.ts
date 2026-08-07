import { Kysely, sql } from 'kysely';

/**
 * Actionable items — the event pipeline's output and the substance of the
 * curated cards (RENKEI.md, orchestration layer).
 *
 * Each row carries its evidence (source references and excerpts, jsonb), its
 * one suggested action in tool-call shape, and its decision audit: who
 * approved or dismissed it and what executing it produced. Lifecycle:
 *
 *   suggested → approved → executed | failed
 *             → dismissed
 *
 * Items are kept after execution — the card feed is also the audit trail of
 * what Renkei suggested and what humans did with it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('actionable_items')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    // The connector whose event produced this item ('webex', …).
    .addColumn('source', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('suggested'))
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('summary', 'text', (col) => col.notNull())
    // Source references and excerpts backing the suggestion.
    .addColumn('evidence', 'jsonb', (col) => col.notNull())
    // The proposed action in tool-call shape: { tool, args }.
    .addColumn('suggested_action', 'jsonb', (col) => col.notNull())
    // OIDC subject of whoever approved or dismissed, and when.
    .addColumn('decided_by', 'varchar(255)')
    .addColumn('decided_at', 'timestamp')
    // What execution produced: an issue key and URL, or the failure reason.
    .addColumn('result', 'jsonb')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // The feed's exact shape: a tenant's items by status, newest first.
  await db.schema
    .createIndex('idx_actionable_items_feed')
    .on('actionable_items')
    .columns(['tenant_id', 'status', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('actionable_items').execute();
}

import { Kysely, sql } from 'kysely';

/**
 * The events queue — Decision #7 made literal (see RENKEI.md).
 *
 * Every producer, webhook route and scheduler job alike, does exactly one
 * thing: INSERT a row here. The worker is the only consumer; it claims rows
 * with FOR UPDATE SKIP LOCKED so any number of worker processes can compete
 * without coordination, and a crashed worker's claim is reclaimed by
 * staleness (the `atlassian_refresh_locks` pattern).
 *
 * Lifecycle: pending → processing → processed, with failures returning to
 * pending until the attempt budget is spent, after which the row is `dead`
 * and holds its last error for inspection. Dead rows are kept, not deleted:
 * a queue that silently drops events cannot be audited.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    // Every platform table carries the org FK (Decision #5).
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    // The producing connector ('webex', 'scheduler:sharepoint', ...). A
    // consumer must never care whether a webhook or a sweep produced the row,
    // but observability does.
    .addColumn('source', 'varchar(255)', (col) => col.notNull())
    // The event kind within the source's namespace ('message.created', ...).
    .addColumn('type', 'varchar(255)', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    // Not-before time; retries push it forward for backoff.
    .addColumn('run_after', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    // Set when claimed; a `processing` row with an old locked_at is a crashed
    // worker's orphan and is eligible for reclaim.
    .addColumn('locked_at', 'timestamp')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // The claim query's exact shape: ready work, oldest first.
  await db.schema
    .createIndex('idx_events_claim')
    .on('events')
    .columns(['status', 'run_after', 'created_at'])
    .execute();

  await db.schema.createIndex('idx_events_tenant_id').on('events').column('tenant_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('events').execute();
}

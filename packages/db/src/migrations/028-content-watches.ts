import { Kysely, sql } from 'kysely';

/**
 * Poll-based content watches, and the sync progress every connector can
 * report from.
 *
 * `content_watches` is what a user points Renkei at — a Jira project or a
 * Confluence space — for periodic indexing. Deliberately NOT
 * `webhook_subscriptions`: that table means "a webhook WE created at the
 * provider and must keep alive", carrying `subscription_id`,
 * `client_state` (NOT NULL) and `expires_at`. A poll watch has none of
 * those, and Atlassian gives an OAuth app no way to create a Confluence
 * webhook at all, so reusing it would leave three columns permanently
 * meaningless while implying a provider-side subscription that does not
 * exist.
 *
 * What that table gets right and this one keeps: the row is BOTH the watch
 * configuration and its cursor, so one idempotent sync core can serve the
 * sweep and any future producer without caring which fired.
 *
 * The counters exist because sync progress is otherwise invisible: a user
 * who connects a mailbox sees nothing happening for minutes. Totals are
 * genuinely unknowable up front (no provider tells you how many items a
 * delta will yield), so these are running counts to display, never a
 * denominator for a percentage.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('content_watches')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    // 'jira' | 'confluence' — matches the knowledge_chunks.provider written
    // by the poller, so the ACL verifier for a chunk is found by this key.
    .addColumn('provider', 'varchar(32)', (col) => col.notNull())
    // The owning grant. Polling runs with THIS user's credential, so a watch
    // can never surface content its owner could not read themselves.
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // 'project' (Jira) | 'space' (Confluence).
    .addColumn('scope_type', 'varchar(16)', (col) => col.notNull())
    // The project key or space key/id being watched.
    .addColumn('scope_key', 'varchar(255)', (col) => col.notNull())
    // Human label for the UI, so listing watches needs no provider call.
    .addColumn('scope_label', 'varchar(255)')
    // Opaque high-water mark: the newest item timestamp successfully
    // ingested. NULL means "never synced" and triggers a full first pass.
    .addColumn('cursor', 'text')
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    // --- progress, mirrored on webhook_subscriptions below ---
    .addColumn('last_synced_at', 'timestamptz')
    .addColumn('last_run_items', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('total_items', 'integer', (col) => col.notNull().defaultTo(0))
    // 'idle' | 'syncing' | 'error' — what the connectors page renders.
    .addColumn('sync_status', 'varchar(16)', (col) => col.notNull().defaultTo('idle'))
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // One watch per scope per user: watching a project twice is the same watch.
  await db.schema
    .createIndex('idx_content_watches_scope')
    .unique()
    .on('content_watches')
    .columns(['tenant_id', 'provider', 'subject', 'scope_type', 'scope_key'])
    .execute();

  // The sweep asks "what is due?" — enabled rows ordered by staleness.
  await db.schema
    .createIndex('idx_content_watches_due')
    .on('content_watches')
    .columns(['enabled', 'last_synced_at'])
    .execute();

  // Microsoft already has its per-resource sync row; it just never recorded
  // how much it had done. Same three counters + status so one UI can read
  // progress for every connector without special-casing.
  await db.schema
    .alterTable('webhook_subscriptions')
    .addColumn('last_synced_at', 'timestamptz')
    .execute();
  await db.schema
    .alterTable('webhook_subscriptions')
    .addColumn('last_run_items', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable('webhook_subscriptions')
    .addColumn('total_items', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable('webhook_subscriptions')
    .addColumn('sync_status', 'varchar(16)', (col) => col.notNull().defaultTo('idle'))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('webhook_subscriptions').dropColumn('sync_status').execute();
  await db.schema.alterTable('webhook_subscriptions').dropColumn('total_items').execute();
  await db.schema.alterTable('webhook_subscriptions').dropColumn('last_run_items').execute();
  await db.schema.alterTable('webhook_subscriptions').dropColumn('last_synced_at').execute();
  await db.schema.dropTable('content_watches').execute();
}

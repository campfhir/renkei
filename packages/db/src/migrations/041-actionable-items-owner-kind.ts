import { Kysely, sql } from 'kysely';

/**
 * Cards grow owners, kinds and provenance — the columns that let agents
 * (and users, over MCP) put INFORMATIONAL cards on a person's feed.
 *
 * - `owner_subject`: whose feed the card belongs to. NULL keeps the
 *   original meaning — tenant-wide, visible to every signed-in user (all
 *   pre-existing rows) — so nothing already on a feed moves or disappears.
 *   Non-null scopes the card to exactly that subject's feed: a morning
 *   summary written by someone's agent is theirs, not the org's.
 *
 * - `kind`: 'action' (the original shape — carries a suggested_action to
 *   approve or dismiss) or 'info' (nothing to execute; dismissing IS the
 *   acknowledgment). Migration 024's invariant is untouched: decision is
 *   a status, archive is a timestamp, and nothing leaves the feed
 *   undecided.
 *
 * - `suggested_action` becomes nullable because an info card has nothing
 *   to execute; NULL says that plainly where an empty-object sentinel
 *   would make every reader guess.
 *
 * - `created_by` (OIDC subject) and `created_by_agent_id` say who put the
 *   card on the feed — the answer to "why is this here?". The agent FK
 *   self-cleans on agent deletion (SET NULL) rather than blocking it;
 *   `created_by` NULL marks rows from the ambient pipeline, which is what
 *   makes pipeline cards immutable from MCP (the tools require a creator).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('actionable_items')
    .addColumn('owner_subject', 'varchar(255)')
    .execute();
  await db.schema
    .alterTable('actionable_items')
    .addColumn('kind', 'varchar(16)', (col) => col.notNull().defaultTo('action'))
    .execute();
  await db.schema
    .alterTable('actionable_items')
    .alterColumn('suggested_action', (col) => col.dropNotNull())
    .execute();
  await db.schema.alterTable('actionable_items').addColumn('created_by', 'varchar(255)').execute();
  await db.schema
    .alterTable('actionable_items')
    .addColumn('created_by_agent_id', 'uuid', (col) =>
      col.references('agents.id').onDelete('set null')
    )
    .execute();

  // The feed query now carries an owner predicate (mine OR tenant-wide);
  // mirror 024's partial-index shape for it.
  await sql`
    CREATE INDEX idx_actionable_items_owner_unarchived
    ON actionable_items (tenant_id, owner_subject, created_at DESC)
    WHERE archived_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_actionable_items_owner_unarchived`.execute(db);
  await db.schema.alterTable('actionable_items').dropColumn('created_by_agent_id').execute();
  await db.schema.alterTable('actionable_items').dropColumn('created_by').execute();
  // Restore NOT NULL only after backfilling rows that used the nullable
  // window; info cards get an empty object so the constraint can hold.
  await sql`UPDATE actionable_items SET suggested_action = '{}'::jsonb WHERE suggested_action IS NULL`.execute(
    db
  );
  await db.schema
    .alterTable('actionable_items')
    .alterColumn('suggested_action', (col) => col.setNotNull())
    .execute();
  await db.schema.alterTable('actionable_items').dropColumn('kind').execute();
  await db.schema.alterTable('actionable_items').dropColumn('owner_subject').execute();
}

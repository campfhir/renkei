import { Kysely, sql } from 'kysely';

/**
 * Archiving for the card feed. Deciding a card (approve/dismiss) is about
 * WHAT HAPPENS to the suggestion; archiving is about WHETHER IT KEEPS
 * OCCUPYING THE FEED. Splitting the two keeps the audit trail intact: an
 * archived card is hidden from the default view, never deleted, and the
 * history view still shows everything.
 *
 * Dismissal archives in the same stroke (one click removes the card from
 * view), and any decided card can be archived later — but a `suggested`
 * card cannot be archived directly, so nothing disappears undecided.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('actionable_items').addColumn('archived_at', 'timestamp').execute();
  await db.schema.alterTable('actionable_items').addColumn('archived_by', 'varchar(255)').execute();

  // The default feed reads only unarchived rows; a partial index keeps that
  // query from paying for a history it no longer shows.
  await sql`
    CREATE INDEX idx_actionable_items_unarchived
    ON actionable_items (tenant_id, created_at DESC)
    WHERE archived_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_actionable_items_unarchived`.execute(db);
  await db.schema.alterTable('actionable_items').dropColumn('archived_by').execute();
  await db.schema.alterTable('actionable_items').dropColumn('archived_at').execute();
}

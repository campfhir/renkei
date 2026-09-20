import { Kysely, sql } from 'kysely';

/**
 * Coach marks — the guided tours that walk somebody through a workflow or
 * a new feature (apps/web/lib/coach-marks). One row per person per tour,
 * saying how far they got and how it ended, so the engine knows what not
 * to show again and an operator can report on adoption.
 *
 * Its own table rather than a document in `user_preferences` (060): the
 * report counts and joins across people ("who completed the welcome tour,
 * who skipped it"), which a jsonb blob keyed by subject cannot answer with
 * a query. And not `audit_events` (038), whose own comment refuses usage
 * telemetry — a tour step being viewed is exactly that.
 *
 * `status` is the LATEST outcome: 'viewed' (started, neither finished nor
 * skipped yet), 'completed', or 'dismissed'. The three counters survive a
 * replay — somebody who finished a tour once and skipped its replay still
 * reads as having completed it — and `tour_version` records which edition
 * of the tour the row describes, so a reworked tour (its version bumped in
 * code) shows again to people who saw the old one.
 *
 * Keyed by (tenant, subject) like every other per-person table, never by
 * an identity FK: the row must outlive an identity re-upsert at sign-in.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('coach_mark_progress')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // The tour's id in the registry ('welcome', 'agents'…).
    .addColumn('tour_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('tour_version', 'integer', (col) => col.notNull().defaultTo(1))
    // 'viewed' | 'completed' | 'dismissed' — the latest outcome.
    .addColumn('status', 'varchar(16)', (col) => col.notNull())
    // The furthest step index (0-based) reached this time through, and how
    // many steps the tour had, so a report can say "skipped at step 2 of 6".
    .addColumn('step_reached', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('steps_total', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('view_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('completed_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('dismissed_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('first_viewed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('last_viewed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('completed_at', 'timestamptz')
    .addColumn('dismissed_at', 'timestamptz')
    // The browser's own clock on the latest report applied. Reports leave
    // the browser as they happen and may arrive in any order; one older
    // than this is a straggler and is ignored, so a 'viewed' that lands
    // after the 'dismissed' it preceded cannot reopen the pass.
    .addColumn('reported_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('coach_mark_progress_pkey', ['tenant_id', 'subject', 'tour_id'])
    .execute();

  // The report reads one tour across everyone.
  await db.schema
    .createIndex('idx_coach_mark_progress_tour')
    .on('coach_mark_progress')
    .columns(['tenant_id', 'tour_id', 'status'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('coach_mark_progress').execute();
}

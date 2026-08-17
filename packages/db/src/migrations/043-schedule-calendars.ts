import { Kysely, sql } from 'kysely';

/**
 * Org holiday calendars for schedule blackouts.
 *
 * Holidays are org facts, not per-agent facts: entering Christmas on every
 * agent's schedule separately guarantees drift, so an admin maintains a
 * named calendar once and any schedule trigger opts into it by id
 * (`config.calendarId`), optionally layering its own extra dates on top.
 *
 * `dates` is one jsonb array of BlackoutEntry objects (`{date}` one-offs,
 * `{start, end}` ranges, `{annual: 'MM-DD'}` fixed-date holidays, each
 * with an optional label) rather than a child table: calendars are small
 * (tens of entries), always read whole, and edited whole in one admin
 * form — a row per date would buy joins and nothing else.
 *
 * Calendar edits apply from each schedule's NEXT computation (fire or
 * save); already-stored next_run_at values are not retro-adjusted. The
 * admin page says so.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('schedule_calendars')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('name', 'varchar(100)', (col) => col.notNull())
    .addColumn('dates', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Names are how triggers' editors refer to calendars; two "US Holidays"
  // in one org is a support ticket.
  await db.schema
    .createIndex('idx_schedule_calendars_tenant_name')
    .unique()
    .on('schedule_calendars')
    .columns(['tenant_id', 'name'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('schedule_calendars').execute();
}

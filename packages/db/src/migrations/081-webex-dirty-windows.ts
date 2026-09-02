import { Kysely, sql } from 'kysely';

/**
 * WebEx is indexed by ROOM-DAY, not by message, and this table is the
 * coalescing buffer between the two.
 *
 * A single chat message is a poor retrieval unit: most are under a hundred
 * characters, their embedding is a near-meaningless point, and nothing
 * about "ok will do" says which conversation it belonged to. A room's day
 * rendered as a transcript — the same shape a Zoom transcript already
 * takes — is what a person actually wants back: the conversation around
 * the thing they remember.
 *
 * Every captured message therefore marks its (room, UTC day) dirty here
 * instead of being ingested on its own. A sweep in the interactive worker
 * (health/webex-windows.ts) picks up windows that have been quiet for a
 * moment and enqueues ONE rebuild each onto the embedding queue, so a burst
 * of fifty messages costs one WebEx list call and one embedding pass, not
 * fifty. The rebuild refetches the whole day from WebEx with a watcher's
 * own token, so edits and deletions come out in the wash.
 *
 * `subject` is the watcher whose token can read the room. Nullable because
 * the seed below comes from legacy rows that never recorded one; the sweep
 * then picks any opted-in watcher of the tenant. `day` is text, not date:
 * it is a key ('2026-09-02', UTC), and a date column would come back from
 * the driver as a local-midnight Date that has to be re-derived.
 *
 * The seed marks every (room, day) the old per-message rows covered, so the
 * sweep rebuilds them as windows; the rebuild handler deletes the legacy
 * rows of a day only once its window is written, so search never has a
 * gap — nor, for long, both shapes at once.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('webex_dirty_windows')
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('room_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('day', 'varchar(10)', (col) => col.notNull())
    .addColumn('subject', 'varchar(255)')
    .addColumn('marked_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('webex_dirty_windows_pkey', ['tenant_id', 'room_id', 'day'])
    .execute();

  await db.schema
    .createIndex('idx_webex_dirty_windows_marked')
    .on('webex_dirty_windows')
    .columns(['marked_at'])
    .execute();

  await sql`
    INSERT INTO webex_dirty_windows (tenant_id, room_id, day, subject)
    SELECT DISTINCT
      tenant_id,
      split_part(ref_id, '/', 1),
      to_char(source_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      NULL
    FROM knowledge_chunks
    WHERE provider = 'webex'
      AND ref_id NOT LIKE '%/day/%'
      AND source_at IS NOT NULL
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('webex_dirty_windows').execute();
}

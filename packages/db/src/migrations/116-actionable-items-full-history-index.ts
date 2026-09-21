import { Kysely, sql } from 'kysely';

/**
 * The feed's "Show archived" query — the same tenant/owner shape as
 * 041's partial index, but reading the full history (archived rows
 * included) rather than only the unarchived ones. That query had no
 * index of its own: the closest one, 041's, is `WHERE archived_at IS
 * NULL`, so Postgres cannot use it once archived rows are back in play,
 * and falls back to a tenant-only scan followed by an explicit sort —
 * fine while a tenant's history is small, and increasingly not as
 * items accumulate (they are never deleted, only archived).
 *
 * A second, non-partial index with the same column order lets both the
 * `ORDER BY created_at DESC LIMIT 50` in cards.tsx and the
 * actionable-items API route satisfy the sort directly off the index,
 * with or without the archived filter.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX idx_actionable_items_owner_all
    ON actionable_items (tenant_id, owner_subject, created_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_actionable_items_owner_all`.execute(db);
}

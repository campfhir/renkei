import { Kysely, sql } from 'kysely';

/**
 * "I am on this page, as of now" — a heartbeat the browser sends while a
 * page is open and visible (apps/web/components/notification-center.tsx),
 * so the server can tell a redundant push from a real one: a chat reply
 * arriving while its own chat page was just pinged has already been seen
 * live (the turn stream), so there is nothing left for a banner to say
 * (apps/web/lib/chat/reply-notification.ts).
 *
 * `path` rather than a chat id: the ping is a generic "where is this
 * person right now", pathname-only the same way the service worker's own
 * `quiet` check matches `new URL(client.url).pathname` — nothing here is
 * chat-specific, only its one reader is so far.
 *
 * Keyed by `(tenant_id, subject, path)` and upserted in place: a person
 * with several tabs open on different pages gets one row per page, and
 * repeated pings from the same page just move `updated_at` forward rather
 * than piling up history nothing reads. `updated_at` is a fresh
 * `new Date()` from the app process, not `NOW()` in SQL, so the write and
 * the "was this recent" read it is later compared against
 * (@renkei/notifications' presence.ts) share one clock.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('presence_pings')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('path', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('presence_pings_pkey', ['tenant_id', 'subject', 'path'])
    .execute();

  // The maintenance sweep's only access pattern: "everything older than a
  // fixed cutoff, regardless of tenant" — a global index on the age column
  // is what that scan wants, not a per-tenant one.
  await db.schema
    .createIndex('idx_presence_pings_updated_at')
    .on('presence_pings')
    .column('updated_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('presence_pings').execute();
}

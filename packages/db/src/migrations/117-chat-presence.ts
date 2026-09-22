import { Kysely, sql } from 'kysely';

/**
 * "Somebody is watching this chat's turn stream, right now" — refreshed by
 * the turn stream route itself (apps/web/app/api/tenant/[tenantId]/chat/
 * chats/[chatId]/turns/[turnId]/stream/route.ts) on connection open, on its
 * existing 15s keep-alive heartbeat, and again the instant it sends
 * `turn_end` — so a reply that just finished streaming to an open tab
 * leaves a near-zero-age row behind it.
 *
 * That route's fast path (`getTurnChannel`, turn-events.ts) is explicitly
 * in-process only — a load-balanced deployment can easily have the stream
 * served by a different replica than the one finishing the turn — so this
 * table, not that in-memory channel, is what `notifyChatReplyDesktop`
 * (reply-notification.ts) checks before sending a reply's desktop
 * notification: a durable, cross-replica-visible answer to "was anyone
 * actually watching".
 *
 * Keyed by `(tenant_id, subject, chat_id)`, one row per person per chat —
 * a chat has at most one turn streaming at a time, so there is nothing to
 * disambiguate by turn. Upserted in place: a long-running turn's repeated
 * heartbeats move `updated_at` forward rather than piling up rows.
 * `updated_at` is a fresh `new Date()` from the app process, not `NOW()`
 * in SQL, so the write and the "was this recent" read it is later compared
 * against (@renkei/notifications' presence.ts) share one clock.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('chat_presence')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('chat_presence_pkey', ['tenant_id', 'subject', 'chat_id'])
    .execute();

  // The maintenance sweep's only access pattern: "everything older than a
  // fixed cutoff, regardless of tenant" — a global index on the age column
  // is what that scan wants, not a per-tenant one.
  await db.schema
    .createIndex('idx_chat_presence_updated_at')
    .on('chat_presence')
    .column('updated_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('chat_presence').execute();
}

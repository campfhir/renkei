import { Kysely, sql } from 'kysely';

/**
 * Messages a person queued behind a running reply, kept across reloads.
 *
 * The composer's queue lived only in the page's memory: reloading, opening
 * the chat elsewhere, or navigating away dropped whatever was waiting.
 * One row per chat holds the whole ordered list (message inputs and
 * compaction requests) as the composer built it; the page rewrites it on
 * every change and reads it back with the chat.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('chat_queued_sends')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('queue', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('chat_queued_sends_pkey', ['tenant_id', 'chat_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('chat_queued_sends').execute();
}

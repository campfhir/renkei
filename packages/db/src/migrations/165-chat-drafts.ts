import { Kysely, sql } from 'kysely';

/**
 * What a person has typed in a chat's box but not sent, kept across
 * reloads and devices.
 *
 * The composer's text lived only in the page's memory, so reloading,
 * switching chats or picking the conversation up on a phone lost it. One
 * row per chat holds the text, sealed under the chat's key like any other
 * thing the person wrote in it (a draft is unsent chat content); the page
 * saves it a moment after typing stops and reads it back with the chat.
 * Only the owner composes, so there is one draft per chat. No row means no
 * draft: clearing the box deletes the row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('chat_drafts')
    .addColumn('chat_id', 'uuid', (col) =>
      col.primaryKey().references('chats.id').onDelete('cascade')
    )
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('chat_drafts').execute();
}

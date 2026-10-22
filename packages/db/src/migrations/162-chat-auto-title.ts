import { Kysely, sql } from 'kysely';

/**
 * `chats.auto_title_asked` — the model has had its one hidden chance to
 * title the chat after its first prompt (apps/web/lib/chat/chat-title-tools.ts).
 * Set once and never cleared, so the automatic title happens at most once
 * per chat; the person (or the model, when asked) can rename it any time
 * after that through chat_rename.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chats')
    .addColumn('auto_title_asked', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
  // Chats that already exist keep the titles they have: only a chat made
  // from here on gets the automatic one.
  await sql`UPDATE chats SET auto_title_asked = true`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE chats DROP COLUMN auto_title_asked`.execute(db);
}

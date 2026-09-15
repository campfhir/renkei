import { Kysely, sql } from 'kysely';

/**
 * `chat_turns.kind` — a compaction pass (compaction.ts's startCompactionTurn)
 * rides the same `chat_turns` row the model's own replies use, so the
 * partial unique index (one running turn per chat, 092-chat.ts) serializes
 * it against a reply exactly as it would two replies: whichever starts
 * first has the chat until it finishes, and the other is told so
 * (ALREADY_RUNNING) rather than racing it. `kind` is how the client tells
 * the two apart on the same turn/stream machinery — a compaction turn
 * carries no chat_messages rows of its own, only progress events and,
 * on success, a new chat_summaries row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chat_turns')
    .addColumn('kind', 'varchar(16)', (col) => col.notNull().defaultTo('reply'))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE chat_turns DROP COLUMN kind`.execute(db);
}

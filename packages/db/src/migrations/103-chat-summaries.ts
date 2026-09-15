import { Kysely, sql } from 'kysely';

/**
 * Chat compaction — the same shape of problem as agent memory (044), for a
 * chat's own message history rather than an agent's notes.
 *
 * `chat_summaries` is a log, not a single rolling row: every compaction
 * pass (automatic or the `chat_compact` tool) appends one new summary that
 * merges the previous summary's text (if any) with the messages it folds,
 * so only the newest row is ever read back into a prompt — the chain lives
 * in the table for audit, not for replay.
 *
 * `chat_messages.summary_id` is the message-to-summary attribution: set
 * once, on the pass that folded that message, and never moved afterward —
 * a later pass folds the PREVIOUS summary's text (not the messages again),
 * so a message stays attributed to the compaction that actually read it.
 * `buildHistory` (request-builder.ts) excludes every message with a
 * non-null `summary_id` regardless of which summary it names, since the
 * latest summary already carries that content forward.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('chat_summaries')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('content', 'text', (col) => col.notNull())
    // The highest seq folded as of this pass — where the next pass's
    // "messages after this point" search resumes.
    .addColumn('through_seq', 'integer', (col) => col.notNull())
    .addColumn('folded_count', 'integer', (col) => col.notNull())
    // 'auto' (start-turn.ts, over the size threshold), 'tool' (the model
    // called chat_compact) or 'user' (the person forced it).
    .addColumn('created_by', 'varchar(16)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('idx_chat_summaries_chat')
    .on('chat_summaries')
    .columns(['tenant_id', 'chat_id', 'created_at desc'])
    .execute();

  await db.schema
    .alterTable('chat_messages')
    .addColumn('summary_id', 'uuid', (col) => col.references('chat_summaries.id').onDelete('set null'))
    .execute();
  // "Which messages still need sending in full" is the hot read (every
  // buildHistory call); a partial index over the unfolded rows only.
  await sql`
    CREATE INDEX idx_chat_messages_unfolded
      ON chat_messages (chat_id, seq)
      WHERE summary_id IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chat_messages').dropColumn('summary_id').execute();
  await db.schema.dropTable('chat_summaries').execute();
}

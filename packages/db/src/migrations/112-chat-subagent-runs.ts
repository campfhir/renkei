import { Kysely, sql } from 'kysely';

/**
 * `chat_subagent_runs` — what a code chat's sub-agents did
 * (apps/web/lib/code/delegate.ts, `code_delegate`). A sub-agent is a
 * model loop of its own: it reads, searches, edits and runs commands in
 * the checkout and hands the orchestrating chat one report. Only that
 * report ever enters the chat's transcript and context — that is the
 * point of delegating — but the sub-agent's own transcript is not
 * thrown away: it is kept here, sealed like a chat's messages, so a
 * person can open the call in the thread and see every step, and so
 * a run that is still going can be followed. One row per delegation,
 * keyed by the `tool_use_id` of the code_delegate call that started it.
 * Deleted with its chat, and with its turn (a resend removes the turn).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('chat_subagent_runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('turn_id', 'uuid', (col) =>
      col.notNull().references('chat_turns.id').onDelete('cascade')
    )
    .addColumn('tool_use_id', 'varchar(128)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('running'))
    .addColumn('task', 'text', (col) => col.notNull())
    .addColumn('instructions', 'text')
    .addColumn('read_only', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('steps', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('max_steps', 'integer', (col) => col.notNull())
    .addColumn('tool_calls', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_tool', 'varchar(200)')
    .addColumn('transcript', 'text')
    .addColumn('report', 'text')
    .addColumn('error', 'text')
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('started_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('finished_at', 'timestamptz')
    .addUniqueConstraint('chat_subagent_runs_call', ['chat_id', 'tool_use_id'])
    .execute();
  await db.schema
    .createIndex('idx_chat_subagent_runs_turn')
    .on('chat_subagent_runs')
    .columns(['turn_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('chat_subagent_runs').execute();
}

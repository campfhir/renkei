import { Kysely } from 'kysely';

/**
 * Where a reply's time went.
 *
 * Until now the ledger and the chat rows could say what a model call cost
 * in tokens and when it ended, but not how long it took — so "the chat
 * spends minutes thinking" and "the provider is slow this week" were the
 * same question with no answer in the database.
 *
 * `llm_calls.duration_ms`: the wall time of the call(s) a row counts —
 * one call for a chat row or a sub-agent's, the sum of an attempt's turns
 * for an agent run's. Null on rows written before this, and on the
 * optimizer's pass.
 *
 * `chat_messages.timing`: on an assistant row, `{durationMs, firstTokenMs}`
 * — the whole model call and the wait before its first streamed block,
 * which is the prefill-and-thinking pause a person sits through. Null on
 * every other row. A tool call's own duration needs no column: it rides on
 * the `tool_result` block inside the sealed content.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('llm_calls').addColumn('duration_ms', 'integer').execute();
  await db.schema.alterTable('chat_messages').addColumn('timing', 'jsonb').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chat_messages').dropColumn('timing').execute();
  await db.schema.alterTable('llm_calls').dropColumn('duration_ms').execute();
}

import { Kysely } from 'kysely';

/**
 * `chat_turns.tool_permission` is the one tool call a running turn is
 * parked behind, waiting for its owner to say yes or no — the same
 * cross-replica shape `cancel_requested_at` has: the runner writes the
 * request here, the decision route writes the answer into the same
 * document, and whichever replica runs the turn reads it back on its
 * next poll. Null whenever nothing is pending; cleared again once the
 * runner has consumed the answer, so a snapshot never shows a stale ask.
 *
 * Shape: { toolUseId, name, messageId, requestedAt, decision?: 'once' |
 * 'always' | 'deny', decidedAt? }. A jsonb document rather than columns
 * because it is one short-lived record per turn, never queried by field.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chat_turns').addColumn('tool_permission', 'jsonb').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chat_turns').dropColumn('tool_permission').execute();
}

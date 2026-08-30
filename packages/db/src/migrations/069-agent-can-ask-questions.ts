import { Kysely } from 'kysely';

/**
 * Whether this agent may raise a dynamic question card mid-step — the
 * `ask_person` free tool the engine offers alongside `finish_step` and
 * `resolve_time` (see docs/approval-and-questions-design.md). Agent-level,
 * not part of the drafted `steps` document: a question a model builds on
 * the fly isn't a node any step points to, it's a capability the whole
 * agent either has or doesn't — the same footing as `guardrails` and
 * `blocked_tools` (migration 052), read live at run time rather than
 * snapshotted onto a run.
 *
 * Defaults to false so existing agents keep behaving exactly as before
 * until an owner opts one in.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agents')
    .addColumn('can_ask_questions', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agents').dropColumn('can_ask_questions').execute();
}

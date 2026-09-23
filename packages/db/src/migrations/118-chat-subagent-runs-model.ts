import { Kysely } from 'kysely';

/**
 * Which model a sub-agent ran on.
 *
 * `chat_subagent_runs` (112) records what a code chat's sub-agent
 * (`code_delegate`, apps/web/lib/code/delegate.ts) did, and until now
 * every sub-agent ran on the turn's own model, so the run had nothing to
 * say about it. Now the orchestrator picks a model per task from the
 * org's roster — a cheaper one for a search, the strongest for a hard
 * change — and the run has to say which one answered, the way the
 * ledger does (098): the provider and model NAME as resolved at the
 * moment, plus the config row as a soft reference. No foreign key, so a
 * config an operator removes later leaves the run's record intact and
 * the name columns still telling the truth. Null on rows written before
 * this migration: those ran on their turn's model (`chat_turns.llm_model_id`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chat_subagent_runs')
    .addColumn('llm_model_id', 'uuid')
    .addColumn('provider', 'varchar(32)')
    .addColumn('model', 'varchar(200)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chat_subagent_runs')
    .dropColumn('llm_model_id')
    .dropColumn('provider')
    .dropColumn('model')
    .execute();
}

import { Kysely } from 'kysely';

/**
 * Durable per-day token tallies alongside the run/failure tallies (049, 050)
 * — same reasoning: `agent_run_steps` rows are pruned by retention and their
 * token columns (071) would only reach back as far as retention does, so an
 * agent's all-time or yearly token usage needs a counter that outlives them.
 *
 * Incremented in the worker engine at every point an attempt's token spend
 * is finalized (mirrors recordAgentRunFailure's call shape: a small,
 * best-effort upsert keyed on today). No backfill — token columns did not
 * exist on agent_run_steps before migration 071, so there is nothing to sum.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_run_counters')
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_run_counters')
    .dropColumn('input_tokens')
    .dropColumn('output_tokens')
    .execute();
}

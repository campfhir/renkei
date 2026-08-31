import { Kysely } from 'kysely';

/**
 * Per-attempt token usage, pulled out of `agent_run_steps.detail` into its
 * own plain columns — the same move migration 035 already made for
 * `tool_call_count`: `detail` is content, gated to the owner (plus admins on
 * FAILED attempts) and pruned by retention, so neither an admin-facing nor a
 * durable token total can be built from it. These columns carry no content
 * (just two integers), so they are visible to any run-history reader and
 * safe to roll up into `agent_run_counters` (see migration 072).
 *
 * No backfill: historical `detail.usage` for rows retention hasn't pruned
 * yet is still readable by whoever could already see that `detail`, but is
 * not worth parsing back out of jsonb for a metric that only matters going
 * forward.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_run_steps')
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_run_steps')
    .dropColumn('input_tokens')
    .dropColumn('output_tokens')
    .execute();
}

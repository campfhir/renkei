import { Kysely, sql } from 'kysely';

/**
 * Failure tallies alongside the run tallies (049), so the oversight page's
 * period toggle can move the Failures column with the Runs column instead of
 * pinning it to a rolling week computed from prunable run rows.
 *
 * A failure lands on the day the run FINISHED (that is when it becomes a
 * failure), which may differ from the day its start was tallied — the two
 * columns are independent counts, not a ratio of the same rows.
 *
 * Incremented in finalizeRun via recordAgentRunFailure; backfilled from
 * whatever failed run rows retention has not yet pruned.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_run_counters')
    .addColumn('failures', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  await sql`
    INSERT INTO agent_run_counters (tenant_id, agent_id, day, runs, failures)
    SELECT tenant_id, agent_id, COALESCE(finished_at, created_at)::date, 0, COUNT(*)
    FROM agent_runs
    WHERE status = 'failed'
    GROUP BY tenant_id, agent_id, COALESCE(finished_at, created_at)::date
    ON CONFLICT (tenant_id, agent_id, day)
    DO UPDATE SET failures = excluded.failures
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agent_run_counters').dropColumn('failures').execute();
}

import { Kysely, sql } from 'kysely';

/**
 * One durable, content-light row per agent run — the ledger the usage
 * page counts runs from and the optimizer reads failures from.
 *
 * Why not `agent_runs` itself: run rows carry content (the steps snapshot,
 * the trigger's input) and are pruned by the org's run retention — 30 days
 * by default — so a year of "how many runs, how many failed, at which
 * step" cannot be read from them. Why not the per-day counters (049/050):
 * a counter keyed on the database's calendar date can never be re-cut
 * into a viewer's own day, and it says how many, never where or why. A
 * row per run with a real timestamp answers both: bucket it in any zone,
 * and on failure it names the step and the kind.
 *
 * Inserted when a run is created (status 'queued'); finalized with the
 * outcome, the step it stopped at (resolved to its NAME, since the
 * snapshot that could resolve it later is on the run row), the engine's
 * error taxonomy, the failed attempt's outcome code, the run error
 * clipped to what `agent_runs.error` already stores, and what the run
 * cost. Never arguments, results, or the model's transcript — those stay
 * on `agent_run_steps.detail` under its own visibility rules for as long
 * as run retention keeps them.
 *
 * `run_id` is the primary key and deliberately NOT a foreign key: the run
 * is pruned long before this row is, and the row must survive it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_run_log')
    .addColumn('run_id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('agent_id', 'uuid', (col) =>
      col.notNull().references('agents.id').onDelete('cascade')
    )
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('trigger_kind', 'varchar(32)', (col) => col.notNull())
    // queued | running | succeeded | failed | stopped | canceled — the
    // run's own vocabulary, mirrored at finalize.
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('queued'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('finished_at', 'timestamptz')
    // Set only when the run failed.
    .addColumn('step_id', 'uuid')
    .addColumn('step_name', 'varchar(200)')
    .addColumn('error_kind', 'varchar(32)')
    .addColumn('outcome_code', 'varchar(64)')
    .addColumn('error', 'varchar(2000)')
    // What the run cost, summed from its attempts at finalize.
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('tool_calls', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    // The agent's steps_version at the time, so a fix that changed the
    // steps can be seen to have worked: failures before vs after.
    .addColumn('steps_version', 'integer')
    .execute();

  // "Every run of the agents this person owns, in a window" — the usage page.
  await db.schema
    .createIndex('idx_agent_run_log_owner')
    .on('agent_run_log')
    .columns(['tenant_id', 'owner_subject', 'created_at'])
    .execute();

  // "This agent's runs (and failures), newest first" — the optimizer.
  await db.schema
    .createIndex('idx_agent_run_log_agent')
    .on('agent_run_log')
    .columns(['tenant_id', 'agent_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_run_log').execute();
}

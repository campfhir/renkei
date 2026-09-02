import { Kysely, sql } from 'kysely';

/**
 * One row per FAILED agent run — the durable, queryable record the
 * optimizer reads and the usage page's "needs attention" list counts.
 *
 * Why a table when `agent_runs` already carries `error`, `error_kind` and
 * `current_step_id`: run rows are pruned by the org's retention window
 * (30 days by default) and their step content is gated per audience, so a
 * question like "which step has this agent been failing on for the last
 * quarter" could only ever be answered for whatever retention happened to
 * still hold. The counters (049/050) survive retention but say only HOW
 * MANY — never WHERE or WHY. This table sits between the two: a compact
 * per-failure record that outlives the run it came from, with the run id
 * kept as a soft reference (nullable, set null on delete) so a row still
 * reads once its run is gone.
 *
 * Content posture: the step's NAME, the engine's error taxonomy, the
 * outcome code, and the run-level error message clipped to the same size
 * `agent_runs.error` already stores. Never arguments, never tool results,
 * never the model's transcript — those stay on `agent_run_steps.detail`
 * for as long as retention keeps them, and the optimizer reads them from
 * there while it can. Token and tool-call totals are integers, so a failed
 * run's cost is readable by an admin as well as the owner.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_run_failures')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('agent_id', 'uuid', (col) =>
      col.notNull().references('agents.id').onDelete('cascade')
    )
    // Soft reference: the run is pruned by retention long before this row.
    .addColumn('run_id', 'uuid', (col) => col.references('agent_runs.id').onDelete('set null'))
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('trigger_kind', 'varchar(32)', (col) => col.notNull())
    // Which step stopped the run, resolved to its name at failure time
    // because the snapshot that could resolve it later is on the run row.
    .addColumn('step_id', 'uuid')
    .addColumn('step_name', 'varchar(200)')
    // The engine's closed taxonomy (config, llm_auth, llm_error, step_failed,
    // timeout, guard, ...) — what the optimizer groups on first.
    .addColumn('error_kind', 'varchar(32)')
    // The failed attempt's outcome code (a tool's enumerated failure, or
    // the author's custom condition slug) when the failure was a step's.
    .addColumn('outcome_code', 'varchar(64)')
    .addColumn('error', 'varchar(2000)')
    // What the failed run cost before it stopped — an integer story only.
    .addColumn('input_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('tool_calls', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    // The agent's steps_version at the time, so a fix that changed the
    // steps can be seen to have worked: failures before vs after.
    .addColumn('steps_version', 'integer')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // "This agent's recent failures, newest first" — the optimizer and the
  // agent page's attention panel.
  await db.schema
    .createIndex('idx_agent_run_failures_agent')
    .on('agent_run_failures')
    .columns(['tenant_id', 'agent_id', 'created_at'])
    .execute();

  // "Every failure across the agents this person owns" — the usage page.
  await db.schema
    .createIndex('idx_agent_run_failures_owner')
    .on('agent_run_failures')
    .columns(['tenant_id', 'owner_subject', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_run_failures').execute();
}

import { Kysely, sql } from 'kysely';

/**
 * Agent run records: one row per run, one row per step ATTEMPT.
 *
 * These tables are the engine's memory, not just its history. The queue
 * message for a run is a bare { runId } pointer; step position and attempt
 * counts live here, so a lease-reclaimed or crashed run RESUMES from the
 * database instead of restarting. `UNIQUE (run_id, step_id, attempt)` is
 * the double-execution tripwire: if two workers ever hold the same run, the
 * second attempt-row insert fails loudly rather than acting twice on an
 * external system. The user-facing 5-attempt cap is likewise enforced by
 * COUNTing these rows, never by trusting the steps snapshot.
 *
 * `steps_snapshot` freezes the agent's steps at enqueue time: an in-flight
 * run executes what was reviewed when it started, not a mid-run edit.
 *
 * CONTENT LIVES HERE, deliberately — a departure from tool_calls' content-
 * free design (migration 032) that must stay explicit: replay and debugging
 * are the product feature of a run record, and the owner knows their agent
 * records its work. The visibility split is an API-layer projection, not a
 * schema split: status/outcome/timing columns are content-free and org-
 * admin-readable for every run; the `detail` jsonb returns only to the
 * owner — plus to admins for FAILED attempts, because troubleshooting
 * broken agents is the admin's job. Retention prunes runs per-tenant
 * (agentRunRetentionDays, default 30); steps go via FK cascade.
 *
 * `lineage` is the ancestor agent-id array for agent-triggers-agent chains:
 * the cycle guard refuses a child whose agent already appears in it, and
 * `depth` bounds the chain (agentMaxChainDepth). The queue cannot provide
 * this — its attempt budget bounds retries, not fan-out.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('agent_id', 'uuid', (col) =>
      col.notNull().references('agents.id').onDelete('cascade')
    )
    // Denormalized at enqueue: whose grants the run acts under, and whose
    // run detail this is — stable even if the agent's owner later changes.
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('trigger_id', 'uuid', (col) =>
      col.references('agent_triggers.id').onDelete('set null')
    )
    .addColumn('trigger_kind', 'varchar(16)', (col) => col.notNull())
    // The API caller or event actor, when known and distinct from the owner.
    .addColumn('triggered_by_subject', 'varchar(255)')
    .addColumn('parent_run_id', 'uuid', (col) =>
      col.references('agent_runs.id').onDelete('set null')
    )
    .addColumn('lineage', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('depth', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('steps_snapshot', 'jsonb', (col) => col.notNull())
    // Which model actually ran, recorded for history — no FK on purpose; a
    // deleted model config must not rewrite what old runs say they used.
    .addColumn('llm_model_id', 'uuid')
    // Identifiers plus small content (a body preview, a work-item JSON) —
    // never attachments or raw bytes; capped at the API boundary (~64KB).
    .addColumn('initial_state', 'jsonb')
    // 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('queued'))
    .addColumn('current_step_id', 'varchar(64)')
    // Failure taxonomy: 'config' | 'llm_auth' | 'llm_rate_limit' |
    // 'llm_error' | 'step_failed' | 'timeout' | 'guard'
    .addColumn('error_kind', 'varchar(32)')
    .addColumn('error', 'text')
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // An agent's run list, newest first.
  await db.schema
    .createIndex('idx_agent_runs_agent_time')
    .on('agent_runs')
    .columns(['tenant_id', 'agent_id', 'created_at'])
    .execute();

  // The admin oversight feed and the retention sweep share this shape.
  await db.schema
    .createIndex('idx_agent_runs_tenant_time')
    .on('agent_runs')
    .columns(['tenant_id', 'created_at'])
    .execute();

  // Live work only: the daily-cap count and the stuck-run janitor.
  await sql`
    CREATE INDEX idx_agent_runs_live ON agent_runs (tenant_id, status)
      WHERE status IN ('queued', 'running')
  `.execute(db);

  await db.schema
    .createTable('agent_run_steps')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('run_id', 'uuid', (col) =>
      col.notNull().references('agent_runs.id').onDelete('cascade')
    )
    // AgentStep.id from the run's snapshot — stable across step reorders.
    .addColumn('step_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('step_index', 'integer', (col) => col.notNull())
    // 1-based TOTAL attempt number for this step within this run.
    .addColumn('attempt', 'integer', (col) => col.notNull())
    // 'running' | 'succeeded' | 'failed'
    .addColumn('status', 'varchar(16)', (col) => col.notNull())
    // How the attempt resolved: 'tool_ok' | 'llm_declared' | 'tool_error' |
    // 'llm_error' | 'timeout' | 'guard'
    .addColumn('outcome', 'varchar(16)')
    // The classified failure condition ('not-found', 'no-permission', ...)
    // that selects which FailureHandling row applies. Content-free.
    .addColumn('outcome_code', 'varchar(64)')
    .addColumn('tool_call_count', 'integer', (col) => col.notNull().defaultTo(0))
    // The content column the visibility projection guards: resolved
    // instruction, LLM summary, tool call previews, token usage. ~64KB cap
    // with truncation markers, enforced by the engine before insert.
    .addColumn('detail', 'jsonb')
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('agent_run_steps_attempt', ['run_id', 'step_id', 'attempt'])
    .execute();

  await db.schema
    .createIndex('idx_agent_run_steps_run')
    .on('agent_run_steps')
    .column('run_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_run_steps').execute();
  await db.schema.dropTable('agent_runs').execute();
}

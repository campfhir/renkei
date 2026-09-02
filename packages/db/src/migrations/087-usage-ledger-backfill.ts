import { Kysely, sql } from 'kysely';

/**
 * Seed the usage ledgers (083, 085) from the run history still within
 * retention, so the pages that now read them are not empty the moment
 * this deploys.
 *
 * Every retained `agent_runs` row becomes a run-log row: status, timing,
 * the cost summed from its attempts, and for a failed run the step it
 * stopped at (its name resolved from the run's own snapshot) and the
 * error taxonomy. Every retained attempt with token spend becomes one
 * token-ledger row, stamped with the attempt's own finish time so it
 * lands on the right day. Idempotent: `ON CONFLICT DO NOTHING` on the run
 * log, and the token ledger is only seeded where the run log had no row
 * yet, so re-running cannot double-count.
 *
 * What is NOT carried over: anything older than the org's run retention.
 * The per-day counters (`agent_run_counters`) hold daily totals back to
 * migration 049 but no per-run rows to convert; they are no longer read or
 * written by any code after this migration, and are left in place rather
 * than dropped so an operator who wants that history still has it. A
 * later migration may drop them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    WITH fresh AS (
      SELECT r.id
      FROM agent_runs r
      LEFT JOIN agent_run_log l ON l.run_id = r.id
      WHERE l.run_id IS NULL
    ),
    spend AS (
      SELECT run_id,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(tool_call_count), 0) AS tool_calls,
             COUNT(*) AS attempts
      FROM agent_run_steps
      GROUP BY run_id
    ),
    last_failed AS (
      SELECT DISTINCT ON (run_id) run_id, outcome_code
      FROM agent_run_steps
      WHERE status = 'failed'
      ORDER BY run_id, step_index DESC, iteration DESC, attempt DESC
    )
    INSERT INTO agent_run_log (
      run_id, tenant_id, agent_id, owner_subject, trigger_kind, status, created_at, finished_at,
      step_id, step_name, error_kind, outcome_code, error,
      input_tokens, output_tokens, tool_calls, attempts, steps_version
    )
    SELECT
      r.id, r.tenant_id, r.agent_id, r.owner_subject, r.trigger_kind, r.status, r.created_at, r.finished_at,
      -- current_step_id is varchar on agent_runs; only a well-formed uuid
      -- can land in the log's uuid column, anything else stays null.
      CASE WHEN r.status = 'failed' AND r.current_step_id ~ '^[0-9a-fA-F-]{36}$' THEN r.current_step_id::uuid END,
      CASE WHEN r.status = 'failed' THEN (
        -- The failed step's name, from the run's own snapshot: top-level
        -- steps only (nested nodes stay nameless here; the engine resolves
        -- them going forward).
        SELECT LEFT(node->>'name', 200)
        FROM jsonb_array_elements(COALESCE(r.steps_snapshot->'steps', '[]'::jsonb)) AS node
        WHERE node->>'id' = r.current_step_id
        LIMIT 1
      ) END,
      CASE WHEN r.status = 'failed' THEN LEFT(r.error_kind, 32) END,
      CASE WHEN r.status = 'failed' THEN LEFT(lf.outcome_code, 64) END,
      CASE WHEN r.status = 'failed' THEN LEFT(r.error, 2000) END,
      COALESCE(s.input_tokens, 0), COALESCE(s.output_tokens, 0), COALESCE(s.tool_calls, 0), COALESCE(s.attempts, 0),
      a.steps_version
    FROM agent_runs r
    JOIN fresh f ON f.id = r.id
    LEFT JOIN spend s ON s.run_id = r.id
    LEFT JOIN last_failed lf ON lf.run_id = r.id
    LEFT JOIN agents a ON a.id = r.agent_id
    ON CONFLICT (run_id) DO NOTHING
  `.execute(db);

  // Token rows for the runs seeded just now — and only those. A run that
  // already had a log row was written by the live engine, which also wrote
  // its ledger rows; seeding its attempts again would double them.
  await sql`
    INSERT INTO llm_calls (tenant_id, subject, agent_id, run_id, step_id, purpose, input_tokens, output_tokens, created_at)
    SELECT s.tenant_id, r.owner_subject, r.agent_id, r.id,
           CASE WHEN s.step_id ~ '^[0-9a-fA-F-]{36}$' THEN s.step_id::uuid END, 'run',
           s.input_tokens, s.output_tokens, COALESCE(s.finished_at, s.started_at, s.created_at)
    FROM agent_run_steps s
    JOIN agent_runs r ON r.id = s.run_id
    WHERE (s.input_tokens > 0 OR s.output_tokens > 0)
      AND NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.run_id = s.run_id)
  `.execute(db);
}

export async function down(): Promise<void> {
  // A backfill is data, not schema; the rows are pruned by the usage
  // retention sweep like any others and are not removed on rollback.
}

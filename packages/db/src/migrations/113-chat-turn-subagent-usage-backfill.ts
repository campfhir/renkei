import { Kysely, sql } from 'kysely';

/**
 * Backfill: a sub-agent's own token usage (`chat_subagent_runs`, 112) was
 * always recorded, but until now never added to the turn it ran in
 * (`chat_turns.input_tokens`/`output_tokens`, 092) — only the
 * orchestrator's own model calls were. So every past turn that delegated
 * (`code_delegate`) undercounts by exactly what its sub-agents cost.
 *
 * The code that now folds a sub-agent's usage into its turn's own total
 * as it happens (`turn-runner.ts`) deploys with this migration, so any
 * `chat_turns` row this UPDATE can see was necessarily written by the old
 * code — this runs once, before the new code ever writes a turn, so there
 * is nothing here for it to double-count.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE chat_turns t
    SET input_tokens = t.input_tokens + s.input_tokens,
        output_tokens = t.output_tokens + s.output_tokens
    FROM (
      SELECT turn_id,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens
      FROM chat_subagent_runs
      GROUP BY turn_id
    ) s
    WHERE s.turn_id = t.id
      AND (s.input_tokens > 0 OR s.output_tokens > 0)
  `.execute(db);
}

export async function down(): Promise<void> {
  // A backfill is data, not schema; not reversed on rollback (087's own
  // convention) — and unlike an insert, subtracting back out here would
  // also undo real usage the live code recorded after this ran.
}

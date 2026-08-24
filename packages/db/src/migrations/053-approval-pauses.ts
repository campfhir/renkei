import { Kysely, sql } from 'kysely';

/**
 * Human-in-the-loop pauses (approval nodes, steps doc v5).
 *
 * A run that reaches an approval node parks as status='waiting' with a
 * concrete deadline in `waiting_until` (the node's timeoutHours clamped by
 * the org's agentApprovalMaxWaitDays), and an `actionable_items` card on
 * the OWNER's home-page feed is the interactive half: Approve / Decline /
 * a typed answer. The card's optimistic status claim (suggested → decided
 * | expired) is the SINGLE arbiter of the outcome; the engine routes the
 * resumed run by what the card says, and the decision route never touches
 * run status.
 *
 * Cards gain a run linkage (run_id/step_id/iteration): approval cards are
 * ENGINE-written only — the MCP card_create tool still hard-codes
 * kind='info', so an agent can never stage an interactive decision on
 * someone's feed. ON DELETE CASCADE means run retention takes the card
 * history with the run — approval decisions are run-scoped history, the
 * accepted trade-off. The unique partial index is a double-insert
 * tripwire for racing executors, same role as agent_run_steps' attempt
 * uniqueness. The typed answer lives in the existing `result` jsonb.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agent_runs').addColumn('waiting_until', 'timestamptz').execute();
  // The timeout sweep's scan; the existing live index covers only
  // queued/running.
  await sql`
    CREATE INDEX idx_agent_runs_waiting
    ON agent_runs (waiting_until)
    WHERE status = 'waiting'
  `.execute(db);

  await db.schema
    .alterTable('actionable_items')
    .addColumn('run_id', 'uuid', (col) => col.references('agent_runs.id').onDelete('cascade'))
    .execute();
  await db.schema
    .alterTable('actionable_items')
    .addColumn('step_id', 'varchar(64)')
    .execute();
  await db.schema.alterTable('actionable_items').addColumn('iteration', 'integer').execute();
  await sql`
    CREATE UNIQUE INDEX idx_actionable_items_run_step
    ON actionable_items (run_id, step_id, iteration)
    WHERE run_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_actionable_items_run_step`.execute(db);
  await db.schema.alterTable('actionable_items').dropColumn('iteration').execute();
  await db.schema.alterTable('actionable_items').dropColumn('step_id').execute();
  await db.schema.alterTable('actionable_items').dropColumn('run_id').execute();
  await sql`DROP INDEX idx_agent_runs_waiting`.execute(db);
  await db.schema.alterTable('agent_runs').dropColumn('waiting_until').execute();
}

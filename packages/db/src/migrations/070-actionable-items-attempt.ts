import { Kysely, sql } from 'kysely';

/**
 * A step can now pause MORE than once per iteration — an `ask_person` call
 * any number of times, plus (on a `needsApproval` step) the gate itself —
 * where the old approval node paused at most once. The card's identity has
 * to grow to match: `(run_id, step_id, iteration)` was unique because only
 * one pause was ever possible there; a second pause on the same iteration
 * now hits that index and is misread as a racing executor
 * (`idx_actionable_items_run_step`'s violation path in engine.ts), wedging
 * the run behind a card that already resolved.
 *
 * `attempt` mirrors `agent_run_steps.attempt` — the same number the paused
 * row carries — so each pause gets its own card without changing what the
 * index protects against (two executors racing to raise the SAME pause's
 * card still collide, since they'd write the same attempt number).
 *
 * Existing rows get no backfill: NULL is fine and stays fine — Postgres
 * treats NULLs as distinct for uniqueness, so historical cards (which
 * predate this column, and by construction never shared a (run_id,
 * step_id, iteration) with another card) never collide with each other or
 * with a new, attempt-numbered card.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('actionable_items').addColumn('attempt', 'integer').execute();

  await sql`DROP INDEX idx_actionable_items_run_step`.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_actionable_items_run_step
    ON actionable_items (run_id, step_id, iteration, attempt)
    WHERE run_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_actionable_items_run_step`.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_actionable_items_run_step
    ON actionable_items (run_id, step_id, iteration)
    WHERE run_id IS NOT NULL
  `.execute(db);
  await db.schema.alterTable('actionable_items').dropColumn('attempt').execute();
}

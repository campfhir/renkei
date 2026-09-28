import { Kysely, sql } from 'kysely';

/**
 * A chat turn that outlives the process that was running it.
 *
 * A turn runs inside the web app (Next's after()), so a deploy, a scale-in
 * or a crash mid-reply used to leave its row `running` with nobody behind
 * it until the janitor called it interrupted fifteen minutes later — and
 * the person sat behind "Replying…" the whole time, then had to resend.
 * Three columns make the turn resumable instead:
 *
 *   `suspended_at` — set by a runner that is shutting down gracefully
 *     (lib/shutdown.ts → turn-runner.ts): "still running, nobody
 *     executing it, pick it up". A crash sets nothing; a stale heartbeat
 *     (`updated_at`) is then the signal, as it always was for the janitor.
 *   `resume_count` — how many times a runner has picked the turn back up,
 *     so one that keeps dying is interrupted after a few rather than
 *     resumed forever (turn-recovery.ts's MAX_TURN_RESUMES).
 *   `runner` — what a resuming process cannot re-derive from the rows:
 *     the roles of the session that sent the turn (the tool surface's
 *     token carries them) and whether it came from voice mode (the prompt
 *     differs). Written at Send; null on turns from before this migration,
 *     which resume with the owner's latest session roles instead.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chat_turns')
    .addColumn('suspended_at', 'timestamptz')
    .addColumn('resume_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('runner', 'jsonb')
    .execute();
  // The recovery sweep's own scan: running turns, oldest heartbeat first.
  await sql`
    CREATE INDEX IF NOT EXISTS chat_turns_running_heartbeat
      ON chat_turns (updated_at)
      WHERE status = 'running'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS chat_turns_running_heartbeat`.execute(db);
  await db.schema
    .alterTable('chat_turns')
    .dropColumn('suspended_at')
    .dropColumn('resume_count')
    .dropColumn('runner')
    .execute();
}

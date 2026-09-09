import { Kysely } from 'kysely';

/**
 * Resuming a failed run from the step it stopped on.
 *
 * A failed run already holds everything a resume needs: `current_step_id`
 * points at the step that stopped it, and the `agent_run_steps` rows are
 * the memory the engine rebuilds position and saved variables from on any
 * re-entry (a crash, an approval wake). What was missing is a record that
 * a person chose to pick the run back up, and the one thing they can add
 * that the engine cannot rediscover: what to do differently this time.
 *
 * - `resumed_at` / `resumed_by` — the latest resume and who asked for it.
 *   `resumed_by` is a subject, distinct from `owner_subject` because a
 *   grantee can resume a run they can see but do not own; the run still
 *   executes on the owner's grants, exactly as a cancel or a rerun does.
 * - `resume_count` — how many times; a run resumed over and over is a
 *   signal the digest and the optimizer can read without scanning rows.
 * - `resume_step_id` — the step the run was resumed AT. `current_step_id`
 *   moves on as the run advances, so the engine needs the frozen pointer
 *   to know which step's attempts get the owner's guidance.
 * - `resume_guidance` — the owner's free-text note for the resumed step
 *   ("the CIO project has no Task type — file it as a Project"), shown to
 *   the model on that step's next attempt. Nullable: a resume with nothing
 *   to add is just "try again from here".
 *
 * The attempts the failure spent are not deleted: the resume marks them
 * `status = 'retired'` on the `agent_run_steps` rows, so the timeline
 * keeps what happened while the engine's budget count ignores them. No
 * schema change for that — status is already free text.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_runs')
    .addColumn('resumed_at', 'timestamptz')
    .addColumn('resumed_by', 'varchar(255)')
    .addColumn('resume_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('resume_step_id', 'varchar(64)')
    .addColumn('resume_guidance', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_runs')
    .dropColumn('resumed_at')
    .dropColumn('resumed_by')
    .dropColumn('resume_count')
    .dropColumn('resume_step_id')
    .dropColumn('resume_guidance')
    .execute();
}

import { Kysely } from 'kysely';

/**
 * Loop support (steps doc v3): one node can now execute several times per
 * run, so the attempt key grows an ITERATION dimension. 0 = not inside a
 * loop — which is every pre-existing row, so the default backfills the
 * history for free; inside a loop iterations are 1-based.
 *
 * The unique constraint is rebuilt under the SAME NAME on purpose: the
 * engine's double-executor tripwire recognizes the race by matching
 * 'agent_run_steps_attempt' in the error message, and a renamed
 * constraint would silently turn that TransientFailure into a crash.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_run_steps')
    .addColumn('iteration', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable('agent_run_steps').dropConstraint('agent_run_steps_attempt').execute();
  await db.schema
    .alterTable('agent_run_steps')
    .addUniqueConstraint('agent_run_steps_attempt', ['run_id', 'step_id', 'iteration', 'attempt'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agent_run_steps').dropConstraint('agent_run_steps_attempt').execute();
  await db.schema
    .alterTable('agent_run_steps')
    .addUniqueConstraint('agent_run_steps_attempt', ['run_id', 'step_id', 'attempt'])
    .execute();
  await db.schema.alterTable('agent_run_steps').dropColumn('iteration').execute();
}

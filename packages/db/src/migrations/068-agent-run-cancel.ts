import { Kysely } from 'kysely';

/**
 * A person's "stop this" for a run that hasn't finished.
 *
 * `queued` and `waiting` runs aren't doing anything a direct status flip
 * can't stop outright — see `requestRunCancel` in @renkei/agents/runs.
 * `running` is different: the engine is mid-loop and owns the row, so
 * cancellation there is a REQUEST, not an edit — `cancel_requested_at`
 * marks it, and the engine's own per-step checkpoint notices it and
 * finalizes as `canceled` at the next boundary rather than mid-tool-call.
 * Nullable and otherwise unused: a run that never had one canceled is no
 * different from before this column existed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_runs')
    .addColumn('cancel_requested_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agent_runs').dropColumn('cancel_requested_at').execute();
}

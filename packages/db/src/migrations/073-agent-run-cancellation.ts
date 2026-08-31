import { Kysely } from 'kysely';

/**
 * A person's ask to stop a run — recorded, never acted on, here.
 *
 * "Run-status transitions belong to the ENGINE alone" (see approvals.ts):
 * the same rule that keeps an approval decision from touching agent_runs
 * directly applies to cancellation. A web route or MCP tool sets
 * `cancel_requested_at` (an idempotent, one-way flag — first write wins)
 * and, for a queued or waiting run, wakes a worker the same way an
 * approval decision does; the engine is the one that reads the flag and
 * performs the actual `status = 'canceled'` transition, at whatever
 * checkpoint it next reaches. A `running` run needs no wake — its own
 * worker notices the flag between steps, since nothing else is driving it.
 *
 * `cancel_requested_by` is the subject who asked, for the run detail page
 * and the digest; distinct from `owner_subject` because a grantee can
 * cancel a run they can see but do not own (access-grants.ts).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_runs')
    .addColumn('cancel_requested_at', 'timestamptz')
    .addColumn('cancel_requested_by', 'varchar(255)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('agent_runs')
    .dropColumn('cancel_requested_at')
    .dropColumn('cancel_requested_by')
    .execute();
}

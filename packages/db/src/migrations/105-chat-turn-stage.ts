import { Kysely } from 'kysely';

/**
 * `chat_turns.stage` names what the loop is doing right now — 'model' while
 * waiting on the LLM, 'tool:<name>' while a tool call is in flight, null
 * between rounds — and `stage_at` is when it started that stage, not just
 * when it last heartbeat. The 250ms flush timer refreshes `updated_at`
 * whichever the runner is doing; it always looked alive. `stage`/`stage_at`
 * say what it was doing when it stopped looking alive, so a turn the
 * janitor has to interrupt leaves a reason behind instead of a bare count.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chat_turns')
    .addColumn('stage', 'varchar(64)')
    .addColumn('stage_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chat_turns').dropColumn('stage').dropColumn('stage_at').execute();
}

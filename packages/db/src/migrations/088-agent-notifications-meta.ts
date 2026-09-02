import { Kysely } from 'kysely';

/**
 * A place for a notification to carry structured facts about the thing it
 * is about — first used by batch-job notifications (kinds `batch_started`,
 * `batch_finished`, `batch_failed`), which need more than a headline can
 * hold: which batch, what kind of job it was, how many items it had and
 * how many succeeded or failed, and why it stopped when it did.
 *
 * This is NOT the body column migration 059 argued against. That argument
 * was about tool ARGUMENTS and result bodies — content that would turn the
 * feed into a transcript. `meta` holds the same class of thing `headline`,
 * `ref_id` and `ref_url` already do: what the provider's own screen would
 * show (a batch's progress line, its status pill), keyed so the feed can
 * render it rather than parse it back out of a sentence. Nothing in it is
 * ever a document's text, a file's bytes, or a tool's input.
 *
 * Nullable, and null for every row written before this: the agent-run and
 * act kinds carry no meta, and the feed treats absence as "nothing extra
 * to show".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agent_notifications').addColumn('meta', 'jsonb').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agent_notifications').dropColumn('meta').execute();
}

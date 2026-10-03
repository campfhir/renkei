import { Kysely, sql } from 'kysely';

/**
 * Microsoft To Do leaves the org knowledge index, after mail and calendar
 * (migration 135).
 *
 * A person's task list is as personal as their inbox: nothing in it is org
 * knowledge the way a Confluence page is, and the `outlook_*` tools read it
 * live through the person's own grant when a chat needs it. With this,
 * nothing in Outlook is indexed at all; the inbox subscription survives
 * only as the feed behind the "An email arrives" agent trigger.
 *
 * So: drop every chunk the Microsoft sync wrote for a task ('task'), and
 * drop the per-list To Do subscription rows, whose Graph subscriptions the
 * worker's ensure pass tears down on its next sweep (the row is only ever
 * polled when the worker wants the resource, and it no longer does).
 *
 * Irreversible by nature — the content came from the provider and can
 * only be re-read from there, which this build no longer does.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM knowledge_chunks
     WHERE provider = 'microsoft'
       AND metadata ->> 'kind' = 'task'
  `.execute(db);
  await sql`
    DELETE FROM webhook_subscriptions
     WHERE provider = 'microsoft'
       AND resource LIKE 'me/todo/lists/%'
  `.execute(db);
}

export async function down(): Promise<void> {
  // Nothing to restore: the rows held provider content this build does not
  // re-ingest. Re-running `up` after a rollback is harmless.
}

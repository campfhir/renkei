import { Kysely, sql } from 'kysely';

/**
 * Outlook mail and calendar leave the org knowledge index.
 *
 * Both are personal: a mailbox and a calendar belong to one person, and
 * nothing in them is org knowledge the way a Confluence page or a To Do
 * item can be. Mail is now read live through the person's own grant, and
 * the inbox subscription survives only as the feed behind the "An email
 * arrives" agent trigger (`mail.received`), which indexes nothing. Calendar
 * has no subscription at all any more.
 *
 * So: drop every chunk the Microsoft sync wrote for a message ('msg') or an
 * event ('evt') — To Do chunks ('task') stay — and drop the `me/events`
 * subscription rows, whose Graph subscriptions the worker's ensure pass
 * tears down on its next sweep (the row is only ever polled when the
 * worker wants the resource, and it no longer does). Inbox rows stay: they
 * are the trigger feed, and their delta cursor is what keeps "arrives"
 * meaning arrives.
 *
 * Irreversible by nature — the content came from the provider and can
 * only be re-read from there, which this build no longer does.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM knowledge_chunks
     WHERE provider = 'microsoft'
       AND metadata ->> 'kind' IN ('msg', 'evt')
  `.execute(db);
  await sql`
    DELETE FROM webhook_subscriptions
     WHERE provider = 'microsoft'
       AND resource = 'me/events'
  `.execute(db);
}

export async function down(): Promise<void> {
  // Nothing to restore: the rows held provider content this build does not
  // re-ingest. Re-running `up` after a rollback is harmless.
}

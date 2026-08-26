import { Kysely, sql } from 'kysely';

/**
 * Messages Renkei posted to WebEx on a user's behalf.
 *
 * The all-spaces ingest used to skip every message the WATCHER authored,
 * which was a blunt instrument aimed at a precise problem. The problem is
 * that Renkei posts as the user — an agent replying in a space, a note to
 * self, a confirmed send all carry the user's own token — so those posts
 * come back through that same user's webhook looking exactly like something
 * they typed. React to them and the agent answers itself, forever, until the
 * daily run cap notices.
 *
 * Skipping by authorship stopped the loop and also threw away every message
 * the person genuinely typed, which is content their own agents and their
 * own knowledge index should see. This table lets the guard be exact: skip
 * what WE sent, process what they wrote.
 *
 * The id is WebEx's, taken from the POST /messages response, so the match at
 * ingest is on identity rather than on a heuristic about text or timing.
 *
 * Rows are hygiene, not history — a worker sweep prunes them after 7 days,
 * the same horizon as agent_trigger_firings. They only need to outlive the
 * window in which a webhook could still deliver the message they describe.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('webex_sent_messages')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    // WebEx's message id. Globally unique, but scoped by tenant anyway so a
    // prune or a tenant delete cannot reach across.
    .addColumn('message_id', 'varchar(255)', (col) => col.notNull())
    // Whose token posted it — the same account the watcher webhook names.
    // Not used for matching (the id is enough); kept because "which account
    // did Renkei post that as" is unanswerable afterwards without it.
    .addColumn('account_id', 'varchar(255)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('webex_sent_messages_pkey', ['tenant_id', 'message_id'])
    .execute();

  // The pruning sweep walks by age.
  await db.schema
    .createIndex('idx_webex_sent_messages_age')
    .on('webex_sent_messages')
    .column('created_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('webex_sent_messages').execute();
}

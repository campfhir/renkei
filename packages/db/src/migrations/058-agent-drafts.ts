import { Kysely, sql } from 'kysely';

/**
 * Drafting an agent from prose, as a job with a durable result.
 *
 * It used to be one synchronous request: the builder POSTed the description
 * and held a spinner open for up to 150 seconds of model time. Three things
 * followed from that, all of them bad. Navigating away — or a phone locking,
 * or a laptop sleeping — threw the work away with nothing to show for it. A
 * result that arrived was held only in React state, so a reload lost it. And
 * the request itself was a long-lived HTTP connection through whatever
 * proxies sit in front of the app, which is the kind of thing that times out
 * at 60 seconds somewhere you cannot see.
 *
 * A row here is the whole lifecycle: what was asked, what came back, and
 * whether it is still running. The builder starts one and polls; leaving the
 * page costs nothing, because the answer is written where the builder can
 * find it next time it opens.
 *
 * `agent_id` is null for a draft of a NEW agent — the common case, since the
 * agent does not exist until the draft is saved. When it IS set, the draft is
 * a revision of an existing agent and the builder can offer it on open.
 *
 * `request` holds the drafting inputs (the prose, the builder's current
 * steps, the trigger variables in scope). It is kept rather than discarded so
 * a failed draft can be retried, and so "what did I actually ask for" is
 * answerable when the result surprises someone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_drafts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    // Whose draft it is. Drafting runs with this subject's tool catalog, so
    // it is a permission boundary and not merely an attribution.
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    // Null for a brand-new agent; set when revising an existing one.
    .addColumn('agent_id', 'uuid', (col) => col.references('agents.id').onDelete('cascade'))
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('queued'))
    .addColumn('request', 'jsonb', (col) => col.notNull())
    .addColumn('result', 'jsonb')
    .addColumn('error', 'text')
    // The adapter's redacted request summary on a provider rejection —
    // shown to the person who asked for the draft, exactly as the
    // synchronous path already did.
    .addColumn('error_detail', 'text')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('finished_at', 'timestamptz')
    // When the builder actually LOADED this draft. A succeeded draft is on
    // offer until it has been picked up; without this the builder would
    // re-offer the same result on every open, which reads as the draft
    // having run again.
    .addColumn('consumed_at', 'timestamptz')
    .execute();

  // "The newest draft for this agent (or for this person's next agent)" is
  // the only question the builder asks, and it asks it on every open.
  await db.schema
    .createIndex('idx_agent_drafts_owner')
    .on('agent_drafts')
    .columns(['tenant_id', 'owner_subject', 'created_at'])
    .execute();

  // The retention sweep walks by age.
  await db.schema
    .createIndex('idx_agent_drafts_age')
    .on('agent_drafts')
    .column('created_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_drafts').execute();
}

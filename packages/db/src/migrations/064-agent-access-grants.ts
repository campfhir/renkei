import { Kysely, sql } from 'kysely';

/**
 * Named-person access to someone else's agent, for troubleshooting.
 *
 * The share token (045) is a fork link — "copy this as a starting point of
 * your own". This is the other thing people ask for: "let Dana see exactly
 * what my agent did and fix its steps", which a copy cannot do because a
 * copy has its own empty run history and runs on the copier's grants.
 *
 * A grant row is the whole mechanism: while one exists (and has not
 * expired), the grantee sees the agent as the owner does — run details
 * unredacted, edit allowed. Deleting the row revokes it. `expires_at` NULL
 * means open-ended; an expired row stays visible in the owner's sharing
 * modal (so they can see it lapsed and delete it) but grants nothing.
 *
 * `owner_subject` is denormalized from the agent on purpose: the queries
 * that matter — "who may act on this agent" and "whose agents may I see" —
 * must not depend on a join to answer who to notify and audit against, and
 * an agent's owner never changes.
 *
 * Whether the owner is PINGED when a grantee saves a change is not a
 * column here — it is a notification preference (user_preferences, on by
 * default), like every other notification switch. The audit trail does not
 * consult it: edits by a non-owner are always audited; only the courtesy
 * ping is optional.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_access_grants')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('agent_id', 'uuid', (col) =>
      col.notNull().references('agents.id').onDelete('cascade')
    )
    .addColumn('owner_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('grantee_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // One grant per person per agent — re-sharing updates the row (new
  // expiry) instead of stacking duplicates.
  await sql`
    CREATE UNIQUE INDEX agent_access_grants_unique
      ON agent_access_grants (agent_id, grantee_subject)
  `.execute(db);

  // "Shared with me": the agents list groups by what the viewer was granted.
  await db.schema
    .createIndex('idx_agent_access_grants_grantee')
    .on('agent_access_grants')
    .columns(['tenant_id', 'grantee_subject'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_access_grants').execute();
}

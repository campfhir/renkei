import { Kysely, sql } from 'kysely';

/**
 * Salesforce admin change requests — the confirm rule for building in a
 * Salesforce org (docs/salesforce-connectors-design.md, "Confirm rule:
 * change requests, applied in the browser"), the Jira admin table's shape
 * (120) with Salesforce's dry run added.
 *
 * Every change the admin connector makes to an org's setup starts as one of
 * these rows. A `salesforce_admin_propose_*` tool, called by a person's
 * chat, an external MCP client or one of their agents, reads the live
 * metadata, builds the exact deployment — the metadata files and their
 * manifest — and stores it in `payload`, with anything that runs after the
 * deploy (granting a new field to permission sets) and what the package was
 * built on (so apply can stop when that has moved). It then runs a
 * check-only deploy in the org; what Salesforce said is `validation`.
 * Applying happens only from the owner's signed-in browser session, on a
 * review page, never from an MCP call; the apply route takes the id and
 * nothing else, so what deploys is what was stored and validated.
 *
 * `status`: 'pending' until someone acts; 'applying' while the apply route
 * holds its claim (a conditional update) and the deploy runs; then
 * 'applied', 'partial' (the deploy succeeded and a later step did not),
 * 'failed', or 'cancelled'. Expiry is read at apply time, never swept.
 *
 * `connector_key` and `org_id` are the org it was built for: apply refuses
 * to run it anywhere else, so reconnecting a connector to a different org
 * cannot redirect an old proposal there. Keyed by subject, never an
 * identity FK; the agent is recorded without an FK too.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('salesforce_admin_change_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // The owner: who proposed it (or whose agent did), and the only person
    // who may apply or cancel it.
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('agent_id', 'uuid')
    .addColumn('connector_key', 'varchar(64)', (col) => col.notNull())
    .addColumn('org_id', 'varchar(18)', (col) => col.notNull())
    .addColumn('instance_url', 'varchar(255)', (col) => col.notNull())
    .addColumn('kind', 'varchar(32)', (col) => col.notNull())
    .addColumn('title', 'varchar(300)', (col) => col.notNull())
    // Why, in the proposer's words — shown on the review page, never run.
    .addColumn('reason', 'text')
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    // The check-only deploy: its id, Salesforce's status, each component's error.
    .addColumn('validation', 'jsonb')
    .addColumn('status', 'varchar(16)', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(sql`status IN ('pending', 'applying', 'applied', 'partial', 'failed', 'cancelled')`)
    )
    .addColumn('results', 'jsonb')
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('applied_by', 'varchar(255)')
    .addColumn('applied_at', 'timestamptz')
    .addColumn('cancelled_at', 'timestamptz')
    .execute();

  // The review list: one person's requests, newest first.
  await db.schema
    .createIndex('idx_salesforce_admin_change_requests_owner')
    .on('salesforce_admin_change_requests')
    .columns(['subject', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('salesforce_admin_change_requests').execute();
}

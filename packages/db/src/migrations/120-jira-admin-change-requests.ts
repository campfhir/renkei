import { Kysely, sql } from 'kysely';

/**
 * Jira admin change requests — the confirm rule for Jira administration
 * (docs/project-management-design.md, "The confirm rule, enforced on the
 * server").
 *
 * Every admin change Renkei makes in Jira starts as one of these rows: a
 * `jira_admin_propose_*` tool, called by a person's chat, an external MCP
 * client or one of their agents, stores the exact operations it would run,
 * and nothing more. Applying happens only from the owner's signed-in
 * browser session, on a review page — never from an MCP call, because an
 * external MCP host cannot prove a click was a person's rather than the
 * model's. The apply route takes the row's id and nothing else, so what
 * runs is what was stored, never what a browser sent.
 *
 * `payload` holds the change itself, shaped by `kind` ('field_options'
 * first; spaces and templates later). `results` holds what each operation
 * returned when applied — with `applied_by`, `applied_at` and the audit
 * event, the record of every admin change Renkei made.
 *
 * `status`: 'pending' until someone acts; 'applying' while the apply route
 * holds its claim (a conditional update, so two clicks cannot both run it);
 * then 'applied', 'partial' (some operations ran before one failed) or
 * 'failed'; or 'cancelled'. Expiry is `expires_at`, read at apply time
 * rather than swept — a pending row past it simply cannot be applied.
 *
 * `cloud_id` is the Jira site the proposal was read from. Apply refuses to
 * run it on any other, so reconnecting to a different site cannot redirect
 * an old proposal there.
 *
 * Keyed by (tenant, subject) like every other per-person table, never by an
 * identity FK: the row must outlive an identity re-upsert at sign-in. The
 * agent that proposed it is recorded without an FK too, so deleting the
 * agent leaves the record intact.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('jira_admin_change_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    // The owner: who proposed it (or whose agent did), and the only person
    // who may apply or cancel it.
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('agent_id', 'uuid')
    .addColumn('cloud_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('site_url', 'varchar(255)')
    .addColumn('kind', 'varchar(32)', (col) => col.notNull())
    .addColumn('title', 'varchar(300)', (col) => col.notNull())
    // Why, in the proposer's words — shown on the review page, never run.
    .addColumn('reason', 'text')
    .addColumn('payload', 'jsonb', (col) => col.notNull())
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
    .createIndex('idx_jira_admin_change_requests_owner')
    .on('jira_admin_change_requests')
    .columns(['tenant_id', 'subject', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('jira_admin_change_requests').execute();
}

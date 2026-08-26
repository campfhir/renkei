import { Kysely, sql } from 'kysely';

/**
 * What an agent DID, addressed to the person whose agent it was.
 *
 * A finished run could say "7 tool calls across 3 tools, 1 failed" and
 * nothing about whether it filed a ticket, sent an email or cancelled a
 * meeting. RENKEI.md's action layer promises the opposite — "actions are
 * first-class, typed... every action records what triggered it" — and this
 * is the record that promise needs.
 *
 * WHAT IS DELIBERATELY ABSENT IS THE POINT, in the same terms as migration
 * 032. There is no arguments column and no result body. `headline`,
 * `ref_id` and `ref_url` are what the provider's own UI would show on its
 * own screen — "Created PROJ-1234", and a link to it. The tool's arguments
 * stay where 032 put them, which is nowhere. Adding a body column later
 * would turn a notification feed into a transcript of everything an
 * employee's automations ever touched, which is a different product and a
 * worse one.
 *
 * WHY NOT `actionable_items`. That table is the cards feed, and it is
 * genuinely close: per-user, agent-authored, run-linked. Three things stop
 * it. Migration 053 puts a UNIQUE index on (run_id, step_id, iteration), so
 * two acts inside one iteration of one step collide — the constraint's
 * stated job is a double-insert tripwire and it is right to keep. Migration
 * 024 states archived cards are NEVER deleted because the card feed is the
 * audit trail, which contradicts the retention this needs. And the
 * cardinalities differ by two orders of magnitude: a card is a decision a
 * person makes, while a foreach loop transitioning forty issues writes
 * forty rows here from a single run.
 *
 * Retention is an org policy (`agentNotificationRetentionDays`, default 14)
 * enforced by a worker sweep — the `agentRunRetentionDays` pattern, one
 * scope down.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('agent_notifications')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    // Addressed, never null — unlike a card's nullable owner_subject, which
    // means "tenant-wide". A notification always has one reader: the person
    // whose agent acted.
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // 'run_started' | 'run_finished' | 'run_failed' | 'act'
    .addColumn('kind', 'varchar(16)', (col) => col.notNull())
    // ActCategory for an act row; null for the run_* kinds.
    .addColumn('category', 'varchar(16)')
    // Catalog capability key — 'jira', 'microsoft', 'webex' — so the
    // preferences page can group by connector and the row can wear a logo.
    .addColumn('connector', 'varchar(64)')
    // The wire tool name, for a per-tool preference override.
    .addColumn('tool', 'varchar(128)')
    // Singular noun: 'issue', 'email', 'page', 'meeting'.
    .addColumn('entity', 'varchar(64)')
    .addColumn('headline', 'text', (col) => col.notNull())
    // The identifier as a person says it: 'PROJ-1234'. Never an internal id.
    .addColumn('ref_id', 'varchar(255)')
    .addColumn('ref_url', 'text')
    .addColumn('agent_id', 'uuid', (col) => col.references('agents.id').onDelete('set null'))
    // Denormalized on purpose: a notification outlives the agent that wrote
    // it, and "one of your agents did this" is useless without the name.
    .addColumn('agent_name', 'varchar(255)')
    .addColumn('run_id', 'uuid', (col) => col.references('agent_runs.id').onDelete('cascade'))
    .addColumn('step_id', 'varchar(64)')
    .addColumn('read_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // The feed: one person's notifications, newest first.
  await sql`
    CREATE INDEX idx_agent_notifications_feed
      ON agent_notifications (tenant_id, subject, created_at DESC)
  `.execute(db);

  // The badge count, and the poll's "anything since?" — both only ever ask
  // about unread rows, so the partial index is the one they use.
  await sql`
    CREATE INDEX idx_agent_notifications_unread
      ON agent_notifications (tenant_id, subject, created_at DESC)
      WHERE read_at IS NULL
  `.execute(db);

  // The retention sweep walks by age within a tenant.
  await db.schema
    .createIndex('idx_agent_notifications_prune')
    .on('agent_notifications')
    .columns(['tenant_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('agent_notifications').execute();
}

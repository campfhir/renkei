import { Kysely, sql } from 'kysely';

/**
 * Mail bulk jobs: the async form of the retired outlook_bulk_* action
 * tools. A 100-message archive under Graph throttling can take minutes —
 * far past any request budget — so the MCP submit tool writes ONE row here,
 * enqueues a bare { jobId } pointer onto the events queue, and returns
 * immediately; the worker executes and updates this row as it goes; the
 * status tool reads it back.
 *
 * The row is the source of truth (the agent_runs rule, migration 036):
 * the queue message carries no state. `subject` is the security boundary —
 * the status tool scopes every lookup by tenant_id AND subject, so a job id
 * alone never reads another user's mailbox activity. Jobs are single-
 * effective-attempt: a redelivery that finds the row already 'running'
 * finalizes it as failed rather than re-acting (a /move returns NEW message
 * ids, so a blind re-run double-acts). Retention: a worker sweep fails
 * stalled runs and prunes terminal rows after 30 days.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('mail_bulk_jobs')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    // The submitting user's OIDC subject — the status tool's scope.
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // provider_account_id, for the worker's resolveMicrosoftAccess.
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    // 'markRead' | 'flag' | 'categorize' | 'move' | 'archive'
    .addColumn('action', 'varchar(16)', (col) => col.notNull())
    // Per-action parameters: isRead / flagStatus / add|remove|replace /
    // destinationFolder / markRead.
    .addColumn('params', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    // { messageIds: [...] } | { filters: {...}, maxMessages }
    .addColumn('selection', 'jsonb', (col) => col.notNull())
    // 'queued' | 'running' | 'succeeded' | 'partial' | 'failed'
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('queued'))
    // Null until the selection is expanded (filters resolve to ids lazily).
    .addColumn('total', 'integer')
    .addColumn('succeeded', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('failed', 'integer', (col) => col.notNull().defaultTo(0))
    // [{ id, error }], capped at 20 — a summary, not a ledger.
    .addColumn('failures', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('last_error', 'text')
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // Status lookups and any future "recent jobs" listing.
  await db.schema
    .createIndex('idx_mail_bulk_jobs_owner_time')
    .on('mail_bulk_jobs')
    .columns(['tenant_id', 'subject', 'created_at'])
    .execute();

  // Live work only: the stalled-job janitor (the idx_agent_runs_live idiom).
  await sql`
    CREATE INDEX idx_mail_bulk_jobs_live ON mail_bulk_jobs (tenant_id, status)
      WHERE status IN ('queued', 'running')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('mail_bulk_jobs').execute();
}

import { Kysely, sql } from 'kysely';

/**
 * Admin change requests become a queue an operator works through.
 *
 * Until now a Salesforce or Jira change request had exactly one actor: the
 * person who proposed it was the only one who could apply it, and the apply
 * ran inside the click that started it. Two things change.
 *
 * Anyone with a connection may *ask* for a change, but only an operator
 * (`renkei-operator`) approves one, so a request has a requester (`subject`,
 * as before) and a separate approver. A requester who cannot build a package
 * files a free-text request (`kind = 'request'`): nothing to deploy, just
 * what they want and why, for an operator to turn into a proposal or decline.
 * `resolution` is the note the requester reads when it is declined or built.
 *
 * Approving no longer runs the change in the browser's request. It moves the
 * row to `queued` and records who approved it (`approved_by`, whose own grant
 * the job acts on) and when; a job on the server then claims it (`applying`),
 * reports what it is doing in `step`, and finishes it. `updated_at` is its
 * heartbeat, so a job whose process died can be told from one that is slow.
 */
const TABLES = ['salesforce_admin_change_requests', 'jira_admin_change_requests'] as const;

const STATUSES_UP = `'pending', 'queued', 'applying', 'applied', 'partial', 'failed', 'cancelled'`;
const STATUSES_DOWN = `'pending', 'applying', 'applied', 'partial', 'failed', 'cancelled'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT IF EXISTS ${sql.id(`${table}_status_check`)}`.execute(
      db
    );
    await sql`ALTER TABLE ${sql.table(table)} ADD CONSTRAINT ${sql.id(`${table}_status_check`)} CHECK (status IN (${sql.raw(STATUSES_UP)}))`.execute(
      db
    );
    await db.schema
      .alterTable(table)
      .addColumn('approved_by', 'varchar(255)')
      .addColumn('approved_at', 'timestamptz')
      .addColumn('step', 'text')
      .addColumn('resolution', 'text')
      .execute();
    // The operators' queue and the job sweep both look for rows by status.
    await sql`CREATE INDEX ${sql.id(`idx_${table}_status`)} ON ${sql.table(table)} (status, updated_at)`.execute(
      db
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`DROP INDEX IF EXISTS ${sql.id(`idx_${table}_status`)}`.execute(db);
    await sql`UPDATE ${sql.table(table)} SET status = 'applying' WHERE status = 'queued'`.execute(
      db
    );
    await db.schema
      .alterTable(table)
      .dropColumn('approved_by')
      .dropColumn('approved_at')
      .dropColumn('step')
      .dropColumn('resolution')
      .execute();
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT IF EXISTS ${sql.id(`${table}_status_check`)}`.execute(
      db
    );
    await sql`ALTER TABLE ${sql.table(table)} ADD CONSTRAINT ${sql.id(`${table}_status_check`)} CHECK (status IN (${sql.raw(STATUSES_DOWN)}))`.execute(
      db
    );
  }
}

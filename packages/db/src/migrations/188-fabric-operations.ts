import { Kysely, sql } from 'kysely';

/**
 * Fabric operations: a Microsoft Fabric request that Fabric answers later.
 *
 * Getting a notebook's or a data pipeline's definition is a long-running
 * operation in Fabric's REST API: the first call may answer 202 with an
 * operation to poll (`Location`, `x-ms-operation-id`, `Retry-After`)
 * rather than the definition. A row here is that wait, owned by the
 * person who asked: the web app polls Fabric for it while their browser
 * watches (a server-sent event stream that re-reads this row), and the
 * worker's sweep polls the rows nobody is watching and tells the person
 * when one ends. `next_poll_at` is both "when Fabric said to look again"
 * and the lease a poller takes before it looks, so two pollers never ask
 * Fabric about the same operation at once.
 *
 * `result` holds the decoded definition parts (text, not base64), capped
 * by the caller; finished rows are deleted after a week by the sweep.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE fabric_operations (
      id UUID PRIMARY KEY,
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workspace_name TEXT NOT NULL DEFAULT '',
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL DEFAULT '',
      format TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      operation_id TEXT,
      percent_complete INTEGER,
      result JSONB,
      error TEXT,
      next_poll_at TIMESTAMPTZ,
      watched_at TIMESTAMPTZ,
      notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `.execute(db);
  await sql`
    CREATE INDEX idx_fabric_operations_subject
      ON fabric_operations (subject, created_at DESC, id DESC)
  `.execute(db);
  await sql`
    CREATE INDEX idx_fabric_operations_due
      ON fabric_operations (next_poll_at)
      WHERE status = 'running'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS fabric_operations`.execute(db);
}

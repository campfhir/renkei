import { Kysely, sql } from 'kysely';

/**
 * The delegate's access record (docs/delegate-key-design.md, "Callers").
 *
 * The delegate now tells its callers apart by the bearer key each
 * presents and refuses an op the caller's row does not allow. The ops that
 * destroy or hand out something — a person's key shredded or rotated, a
 * resource key shared, a git ticket issued, a write sent through the token
 * proxy — leave a row here as well as a log line: who called (by name, not
 * key), what, for which tenant and which person (hashed), about what (an
 * id, never content), and how it ended. The table is append-only: a
 * trigger refuses UPDATE and DELETE, so a process that can write the log
 * cannot rewrite it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE delegate_access_events (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      caller       VARCHAR(32) NOT NULL,
      op           VARCHAR(64) NOT NULL,
      tenant_id    UUID,
      subject_hash VARCHAR(32),
      target       VARCHAR(200),
      outcome      VARCHAR(16) NOT NULL,
      status       INTEGER NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX delegate_access_events_tenant_idx
      ON delegate_access_events (tenant_id, created_at)
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION delegate_access_events_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'delegate_access_events is append-only';
    END
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`
    CREATE TRIGGER delegate_access_events_append_only
      BEFORE UPDATE OR DELETE ON delegate_access_events
      FOR EACH ROW EXECUTE FUNCTION delegate_access_events_append_only()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS delegate_access_events`.execute(db);
  await sql`DROP FUNCTION IF EXISTS delegate_access_events_append_only()`.execute(db);
}

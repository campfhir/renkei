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
 *
 * Device asks (`device_key_requests`) are hardened in the same step: the
 * code grows from six base32 characters of the raw key to ten of its
 * SHA-256 digest (fifty bits), and is TYPED on the approving device rather
 * than picked from a list; each ask is bound to the browser session that
 * made it (`asking_session_id`, cascading with the session) and carries
 * that browser's user agent and time for the approver to judge; wrong
 * codes are counted (`attempts`) and a request is denied after five; an
 * answered or denied ask stays for ten minutes (`consumed_at`,
 * `denied_at`) so asks can be rate-limited per person instead of deleted
 * on pickup; `approved_by_session_id` says which session approved.
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

  await sql`DELETE FROM device_key_requests`.execute(db);
  await sql`ALTER TABLE device_key_requests ALTER COLUMN code TYPE VARCHAR(16)`.execute(db);
  await sql`
    ALTER TABLE device_key_requests
      ADD COLUMN asking_session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
      ADD COLUMN user_agent VARCHAR(200),
      ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN approved_by_session_id UUID,
      ADD COLUMN consumed_at TIMESTAMPTZ,
      ADD COLUMN denied_at TIMESTAMPTZ
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM device_key_requests`.execute(db);
  await sql`
    ALTER TABLE device_key_requests
      DROP COLUMN denied_at,
      DROP COLUMN consumed_at,
      DROP COLUMN approved_by_session_id,
      DROP COLUMN attempts,
      DROP COLUMN user_agent,
      DROP COLUMN asking_session_id
  `.execute(db);
  await sql`ALTER TABLE device_key_requests ALTER COLUMN code TYPE VARCHAR(8)`.execute(db);
  await sql`DROP TABLE IF EXISTS delegate_access_events`.execute(db);
  await sql`DROP FUNCTION IF EXISTS delegate_access_events_append_only()`.execute(db);
}

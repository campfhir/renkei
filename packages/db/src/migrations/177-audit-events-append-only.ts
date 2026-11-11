import { Kysely, sql } from 'kysely';

/**
 * The platform audit trail (`audit_events`, migration 038) becomes
 * append-only in the database itself, the way the PHI access trail (141)
 * and the delegate's access log (144) already are: a trigger refuses
 * UPDATE and DELETE on every row, so no DML path of the application can
 * rewrite or remove a recorded act.
 *
 * Nothing legitimate edits or removes these rows: the store only inserts
 * and reads (`store/domains/audit-events`), no retention sweep touches the
 * table, and the foreign key that once cascaded deletes into it went with
 * the `tenants` table (153). The trigger fires on rows to come; rows
 * already stored are untouched, so the migration is safe on a populated
 * table. It does not fire for TRUNCATE (the differential test harness
 * truncates every table); privilege, not a trigger, gates that.
 *
 * What this does NOT do: stop the table's OWNER. The owner may `ALTER
 * TABLE … DISABLE TRIGGER` or `DROP TRIGGER`. That is closed by running
 * the services as a different, non-owning role (`ensureRuntimeRoles`,
 * DEPLOYMENT.md, "Database roles"), which holds INSERT and SELECT only on
 * this table. On a deployment that keeps the single role, the trigger
 * guards against application bugs and injection, not against a holder of
 * the connection string.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_events_no_update_delete
      BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION audit_events_append_only()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS audit_events_no_update_delete ON audit_events`.execute(db);
  await sql`DROP FUNCTION IF EXISTS audit_events_append_only()`.execute(db);
}

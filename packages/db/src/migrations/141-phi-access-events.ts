import { Kysely, sql } from 'kysely';

/**
 * The PHI access trail: one row every time a person — or one of their
 * agents, acting for them — reads, searches, exports or downloads from a
 * connector whose content is protected health information (Mirth message
 * stores, OnBase documents, network file shares). HIPAA asks who looked
 * at what and when; until now the answer lived only in `tool_calls`,
 * which deliberately records no arguments, so it could say that
 * `mirth_get_message` ran and not which message.
 *
 * What a row carries is IDENTIFIERS AND HASHES, never content: the
 * channel and message id, the OnBase document id, a SHA-256 of the
 * share-relative path (a path is often a patient's name or MRN — the hash
 * lets two reads of the same file be matched without the trail becoming
 * a second copy of the names), the instance or share, the tool, and who.
 * Content stays where it is, under its own access rules.
 *
 * APPEND-ONLY. The migration runs as the application's database user,
 * which owns the table, and a REVOKE on an owner is a no-op — so the
 * guarantee is a trigger that refuses UPDATE and DELETE outright, whatever
 * role connects. Retention is a DBA's decision taken deliberately
 * (DEPLOYMENT.md, "PHI access trail"): disable the trigger, prune, enable
 * it again. Nothing in the application can edit or remove a row.
 *
 * Soft references on purpose: `run_id` and `agent_id` outlive the run and
 * the agent (both are pruned by retention; the trail is not), and
 * `subject` is the person's OIDC subject the identity spine resolves to a
 * name for display.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('phi_access_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('agent_id', 'uuid')
    .addColumn('run_id', 'uuid')
    // mirth | onbase | fileshare
    .addColumn('connector', 'varchar(16)', (col) => col.notNull())
    // The Mirth instance or the file share the read went to; null for OnBase (one per org).
    .addColumn('instance_id', 'uuid')
    // read | search | export | download
    .addColumn('action', 'varchar(16)', (col) => col.notNull())
    .addColumn('tool_name', 'varchar(100)', (col) => col.notNull())
    .addColumn('channel_id', 'varchar(255)')
    .addColumn('message_id', 'varchar(64)')
    .addColumn('document_id', 'varchar(255)')
    // SHA-256 (hex) of the share-relative path; never the path.
    .addColumn('path_hash', 'varchar(64)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
  await sql`
    ALTER TABLE phi_access_events
      ADD CONSTRAINT phi_access_events_connector CHECK (connector IN ('mirth', 'onbase', 'fileshare')),
      ADD CONSTRAINT phi_access_events_action CHECK (action IN ('read', 'search', 'export', 'download'))
  `.execute(db);
  await db.schema
    .createIndex('idx_phi_access_events_subject_time')
    .on('phi_access_events')
    .columns(['tenant_id', 'subject', 'created_at desc'])
    .execute();
  await db.schema
    .createIndex('idx_phi_access_events_tenant_time')
    .on('phi_access_events')
    .columns(['tenant_id', 'created_at desc'])
    .execute();
  await sql`
    CREATE OR REPLACE FUNCTION phi_access_events_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'phi_access_events is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER phi_access_events_no_update_delete
      BEFORE UPDATE OR DELETE ON phi_access_events
      FOR EACH ROW EXECUTE FUNCTION phi_access_events_append_only()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS phi_access_events_no_update_delete ON phi_access_events`.execute(
    db
  );
  await sql`DROP FUNCTION IF EXISTS phi_access_events_append_only()`.execute(db);
  await db.schema.dropTable('phi_access_events').execute();
}

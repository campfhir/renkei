import { Kysely, sql } from 'kysely';

/**
 * ManageEngine ADManager Plus instances — many-per-tenant, the
 * `mirth_instances`/`file_shares` shape (migration 062, 106): an
 * organization may run more than one ADManager Plus server (per domain,
 * per site, or a separate test instance), each with its own host and its
 * own technicians.
 *
 *   - `admanager_instances` is the registry an operator maintains: a name,
 *     an environment label, and how to reach the server's REST API (base
 *     URL, TLS policy). No credential lives here.
 *   - `admanager_instance_connections` is one row per (instance, person):
 *     that person's own ADManager Plus authtoken, sealed in the
 *     `@renkei/crypto` secretbox under TOKEN_ENCRYPTION_KEY, plus their
 *     LLM-exposure choice as named `permissions` (the connector-mirth
 *     shape post-migration-107 from the start — no read/write/destructive
 *     ladder here at all; see docs/admanager-connector-design.md).
 *     ADManager Plus's own authtoken scope, and the technician's own
 *     delegated rights inside ADManager Plus, remain the authority on
 *     every request — these permissions only narrow what the LLM tools
 *     may attempt with a credential the person already holds.
 *
 * Unlike Mirth, there is no username/password login here: ADManager Plus
 * takes the authtoken directly as the Authorization header on every
 * request, so `admanager_instance_connections` has no session state to
 * carry — just the sealed token and the account label a technician
 * recognises (their ADManager Plus technician name, set at connect time
 * from the server's own answer).
 *
 * TLS/http fields mirror `mirth_instances` exactly, same reasoning:
 * ADManager Plus ships behind whatever certificate an IT department set
 * up (often self-signed or internal-CA), and plaintext HTTP to a lab
 * instance must be a recorded operator decision, never a default.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('admanager_instances')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    .addColumn('environment', 'varchar(40)', (col) => col.notNull().defaultTo('prod'))
    // Origin + optional path prefix, no trailing slash; ADManager Plus's
    // REST API lives at `${base_url}/api/v1` and `${base_url}/api/v2`.
    .addColumn('base_url', 'varchar(512)', (col) => col.notNull())
    .addColumn('tls_verify', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('ca_pem', 'text')
    .addColumn('allow_insecure_http', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('settings', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_admanager_instances_tenant_name')
    .unique()
    .on('admanager_instances')
    .columns(['tenant_id', 'name'])
    .execute();

  await db.schema
    .createTable('admanager_instance_connections')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('instance_id', 'uuid', (col) =>
      col.notNull().references('admanager_instances.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('encrypted_credentials', 'text', (col) => col.notNull())
    // The technician name the person enters when connecting — display
    // only, no secret. Unlike Mirth's username (echoed back by its login
    // response), ADManager Plus's REST API has no verified "who am I"
    // endpoint, so this is self-reported rather than server-confirmed;
    // test-connection still validates the AUTHTOKEN itself live.
    .addColumn('technician_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('permissions', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('admanager_instance_connections_pk', [
      'tenant_id',
      'instance_id',
      'subject',
    ])
    .execute();

  await db.schema
    .createIndex('idx_admanager_instance_connections_tenant_subject')
    .on('admanager_instance_connections')
    .columns(['tenant_id', 'subject'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('admanager_instance_connections').execute();
  await db.schema.dropTable('admanager_instances').execute();
}

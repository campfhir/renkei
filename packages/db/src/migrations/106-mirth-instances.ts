import { Kysely, sql } from 'kysely';

/**
 * Mirth Connect (NextGen Connect) integration-engine instances — the second
 * connector, after file shares, that is MANY-PER-TENANT rather than one
 * `connector_configs` row: an organization typically runs several Mirth
 * servers (dev, test, prod, one per site), each with its own host, its own
 * user directory, and its own channels. The tables follow the file-share
 * shape exactly (migration 062), and for the same reason.
 *
 *   - `mirth_instances` is the registry an operator maintains: a name, an
 *     environment label, and how to reach the server's REST API (base URL,
 *     TLS policy). No credential lives here — an admin registers WHERE a
 *     server is, never WHO may use it.
 *   - `mirth_instance_connections` is one row per (instance, person): that
 *     person's own Mirth username and password, sealed in the
 *     `@renkei/crypto` secretbox under TOKEN_ENCRYPTION_KEY (the
 *     `encrypted_secrets` idiom), the username again in the clear for
 *     display, and their LLM-exposure choice — `tool_access` ('read' or
 *     'read_write') and `allow_destructive` — which narrows what the MCP
 *     tools may attempt with a credential the person already holds and is
 *     never read by the worker's I/O path, so it can hide access but not
 *     mint any. Mirth's own user roles and channel-level permissions remain
 *     the authority on every call.
 *
 * Destructive is separate consent from write for the same reason delete is
 * on file shares: removing a channel or purging its message store is
 * permanent, and "may deploy a channel" should not silently imply "may
 * delete it".
 *
 * TLS: Mirth ships with a self-signed certificate on 8443 and most on-prem
 * installs keep one, so `tls_verify` records an EXPLICIT operator decision
 * to skip verification for that instance, and `ca_pem` lets an internal CA
 * be trusted instead — strictly better than switching verification off.
 * `allow_insecure_http` mirrors the OnBase connector: plaintext HTTP to a
 * lab server is real, and must be a recorded choice, never a default.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('mirth_instances')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    // Free text an operator chooses ('dev', 'prod', 'site-a'); it is a label
    // the tools show so a model can tell instances apart, not an enum with
    // behavior attached.
    .addColumn('environment', 'varchar(40)', (col) => col.notNull().defaultTo('prod'))
    // Origin + optional path prefix, no trailing slash, the REST API lives at
    // `${base_url}/api` — the operator pastes what the Administrator's
    // "server URL" says (https://mirth.example:8443).
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
    .createIndex('idx_mirth_instances_tenant_name')
    .unique()
    .on('mirth_instances')
    .columns(['tenant_id', 'name'])
    .execute();

  await db.schema
    .createTable('mirth_instance_connections')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('instance_id', 'uuid', (col) =>
      col.notNull().references('mirth_instances.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('encrypted_credentials', 'text', (col) => col.notNull())
    .addColumn('username', 'varchar(255)', (col) => col.notNull())
    .addColumn('tool_access', 'varchar(10)', (col) =>
      col.notNull().check(sql`tool_access IN ('read', 'read_write')`)
    )
    .addColumn('allow_destructive', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('mirth_instance_connections_pk', [
      'tenant_id',
      'instance_id',
      'subject',
    ])
    .execute();

  // The availability question — "has this subject connected any instance,
  // exposing what?" — runs on every MCP connection, so it gets a direct
  // path, the same treatment file_share_connections has.
  await db.schema
    .createIndex('idx_mirth_instance_connections_tenant_subject')
    .on('mirth_instance_connections')
    .columns(['tenant_id', 'subject'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('mirth_instance_connections').execute();
  await db.schema.dropTable('mirth_instances').execute();
}

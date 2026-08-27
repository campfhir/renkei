import { Kysely, sql } from 'kysely';

/**
 * File shares pivot: the file server is the authorization authority.
 *
 * 061 made Renkei the ACL authority for shares — per-user grants and
 * two-layer path rules enforced over one admin-held service credential.
 * That model was retired deliberately: a bespoke authorization engine plus
 * a super-credential reachable from the web app is a large security surface
 * for Renkei to own, and the file server already has an authorization model
 * of its own. From here on, shares follow the same delegation as every
 * OAuth connector: admins register a share's CONNECTION DETAILS only, each
 * person connects it with their OWN account (a shared account is the org's
 * choice, not Renkei's concern), and what that account may read, write or
 * delete is decided entirely by the file server per operation.
 *
 * So this migration:
 *   - drops the grant and path-rule tables (the ACL) — deliberately
 *     discarding any rows in them;
 *   - drops the shares' service credential and access ceiling columns;
 *   - adds `file_share_connections`: one row per (share, person) holding
 *     the sealed credential (secretbox under TOKEN_ENCRYPTION_KEY, the
 *     `encrypted_secrets` idiom), the account name for display, and the
 *     person's LLM-exposure choice — `tool_access` ('read' or
 *     'read_write') and `allow_delete`, which narrow what the MCP tools
 *     may attempt with the credential but are never read by the worker's
 *     I/O path, so they can hide access, not mint it. Delete is separate
 *     consent because file-server deletion is permanent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('file_share_path_rules').execute();
  await db.schema.dropTable('file_share_grants').execute();

  await db.schema.alterTable('file_shares').dropColumn('max_access').execute();
  await db.schema.alterTable('file_shares').dropColumn('encrypted_credentials').execute();

  await db.schema
    .createTable('file_share_connections')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('share_id', 'uuid', (col) =>
      col.notNull().references('file_shares.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('encrypted_credentials', 'text', (col) => col.notNull())
    .addColumn('username', 'varchar(255)', (col) => col.notNull())
    .addColumn('tool_access', 'varchar(10)', (col) =>
      col.notNull().check(sql`tool_access IN ('read', 'read_write')`)
    )
    .addColumn('allow_delete', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('file_share_connections_pk', ['tenant_id', 'share_id', 'subject'])
    .execute();

  // The availability question — "has this subject connected anything, and
  // exposing what?" — runs on every MCP connection, so it gets a direct
  // path, the same treatment the grant table had.
  await db.schema
    .createIndex('idx_file_share_connections_tenant_subject')
    .on('file_share_connections')
    .columns(['tenant_id', 'subject'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('file_share_connections').execute();

  await db.schema
    .alterTable('file_shares')
    .addColumn('max_access', 'varchar(10)', (col) =>
      col.notNull().defaultTo('read').check(sql`max_access IN ('read', 'read_write')`)
    )
    .execute();
  await db.schema.alterTable('file_shares').addColumn('encrypted_credentials', 'text').execute();

  // The ACL tables come back empty (their rows were discarded on the way
  // up); the shapes match 061 so a re-run of `up` is well-defined.
  await db.schema
    .createTable('file_share_grants')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('share_id', 'uuid', (col) =>
      col.notNull().references('file_shares.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('default_access', 'varchar(10)', (col) =>
      col.notNull().check(sql`default_access IN ('none', 'read', 'read_write')`)
    )
    .addColumn('created_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('file_share_grants_pk', ['tenant_id', 'share_id', 'subject'])
    .execute();

  await db.schema
    .createIndex('idx_file_share_grants_tenant_subject')
    .on('file_share_grants')
    .columns(['tenant_id', 'subject'])
    .execute();

  await db.schema
    .createTable('file_share_path_rules')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('share_id', 'uuid', (col) =>
      col.notNull().references('file_shares.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)')
    .addColumn('path', 'text', (col) => col.notNull())
    .addColumn('access', 'varchar(10)', (col) =>
      col.notNull().check(sql`access IN ('none', 'read', 'read_write')`)
    )
    .addColumn('created_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addForeignKeyConstraint(
      'file_share_path_rules_grant_fk',
      ['tenant_id', 'share_id', 'subject'],
      'file_share_grants',
      ['tenant_id', 'share_id', 'subject'],
      (cb) => cb.onDelete('cascade')
    )
    .execute();

  await sql`
    CREATE UNIQUE INDEX idx_file_share_path_rules_layer_path
    ON file_share_path_rules (share_id, coalesce(subject, ''), path)
  `.execute(db);

  await db.schema
    .createIndex('idx_file_share_path_rules_share_subject')
    .on('file_share_path_rules')
    .columns(['share_id', 'subject'])
    .execute();
}

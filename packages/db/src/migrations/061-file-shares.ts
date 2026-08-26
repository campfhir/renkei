import { Kysely, sql } from 'kysely';

/**
 * Network file shares — the first connector where Renkei is the ACL
 * authority instead of the provider.
 *
 * Every existing connector rides a vendor's own permission model: the user
 * connects their account, and the provider decides what that account sees
 * (RENKEI.md Decision #2). An SMB or SFTP share offers no such delegation —
 * access happens through one service credential the org-admin configures, so
 * the per-user question "may this person see this path?" has no provider to
 * ask. These three tables are that answer, and everything that reads them
 * fails closed: a missing grant row, an unreadable rule, or a decryption
 * failure all mean "no access", never "default access".
 *
 * `file_shares` is not a `connector_configs` row because that table is one
 * row per connector, and shares are many-per-tenant, each with its own host
 * and its own encrypted credential. The credential column follows the
 * `encrypted_secrets` idiom: a secretbox-sealed JSON document under
 * TOKEN_ENCRYPTION_KEY, NULL until an admin has supplied one — and a share
 * without a credential is unusable rather than anonymously connected.
 *
 * The ACL is two rule layers over normalized Unix-style paths:
 *
 *   - share-wide rules (`subject` NULL) apply to everyone granted the share,
 *     with the share's `max_access` as the implicit rule at '/';
 *   - per-user rules (`subject` set) narrow further, with the grant's
 *     `default_access` as that layer's implicit '/' rule.
 *
 * Within a layer the longest matching path prefix wins (inheritance down,
 * deeper rules override); across layers the minimum wins — layers can only
 * narrow, the same invariant the capability registry keeps. A grant may
 * default to 'none' so that "this person sees only these two folders" is
 * expressible as carve-in allow rules under a closed root.
 *
 * Discovery keys on grant-row existence, not on level: no row means the
 * share does not exist for that caller, which is why the availability query
 * (any grant on an enabled share, per subject) gets its own index.
 *
 * Two shapes here need a word:
 *
 *   - Rule uniqueness is an expression index over coalesce(subject, '')
 *     because a plain UNIQUE treats NULL subjects as distinct, which would
 *     let duplicate share-layer rules for one path accumulate.
 *   - Per-user rules carry a composite FK onto the grant they refine, so
 *     revoking a grant deletes that user's rules in the same statement.
 *     MATCH SIMPLE semantics skip rows whose `subject` is NULL, leaving the
 *     share layer untouched by the constraint.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('file_shares')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    .addColumn('protocol', 'varchar(8)', (col) =>
      col.notNull().check(sql`protocol IN ('smb', 'sftp')`)
    )
    .addColumn('host', 'varchar(255)', (col) => col.notNull())
    // NULL means the protocol default (445 / 22), applied in code so the
    // stored value only ever records an explicit choice.
    .addColumn('port', 'integer')
    // SMB's share component of \\host\share; NULL for SFTP. Required-when-smb
    // is an application rule — the admin parser enforces it.
    .addColumn('share_name', 'varchar(255)')
    // Normalized Unix path inside the share (SMB) or the absolute base
    // directory (SFTP). Every user-supplied path resolves strictly under it.
    .addColumn('root_path', 'text', (col) => col.notNull().defaultTo('/'))
    // No DDL default on purpose: the create route sets the protocol default
    // (true for SMB, false for SFTP) explicitly, so the stored value is
    // always a decision rather than an accident of schema.
    .addColumn('case_insensitive', 'boolean', (col) => col.notNull())
    .addColumn('max_access', 'varchar(10)', (col) =>
      col.notNull().defaultTo('read').check(sql`max_access IN ('read', 'read_write')`)
    )
    .addColumn('settings', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('encrypted_credentials', 'text')
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_file_shares_tenant_name')
    .unique()
    .on('file_shares')
    .columns(['tenant_id', 'name'])
    .execute();

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
    // The composite FK from per-user rules names (tenant_id, share_id,
    // subject); MATCH SIMPLE needs a unique target, which the PK provides.
    .execute();

  // The availability question — "does this subject hold any grant?" — runs
  // on every MCP connection, so it gets a direct path.
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
    // NULL = the share-wide layer; set = that user's narrowing layer.
    .addColumn('subject', 'varchar(255)')
    // Normalized Unix path, stored case-preserved; matching folds case when
    // the share says to.
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

  // One rule per (share, layer, path). coalesce() because NULL subjects are
  // distinct under a plain UNIQUE and the share layer would silently accept
  // duplicates for the same path.
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

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('file_share_path_rules').execute();
  await db.schema.dropTable('file_share_grants').execute();
  await db.schema.dropTable('file_shares').execute();
}

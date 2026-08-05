import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Server-side browser sessions. The cookie carries only this opaque id, so a
  // client can neither read nor forge its own subject/roles — the previous
  // oidc_roles_* cookie was unsigned and non-httpOnly, which let anyone
  // self-grant renkei-operator.
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('roles', sql`text[]`, (col) => col.notNull().defaultTo(sql`ARRAY[]::text[]`))
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('last_used_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_sessions_expires_at')
    .on('sessions')
    .column('expires_at')
    .execute();

  // MCP bearer tokens issued by /api/mcp/{tenantId}/oauth/token. Previously the
  // access token was generated and never persisted, so it could not be verified —
  // the MCP transport had no way to identify its caller and fell back to
  // "first grant for the tenant". Only the SHA-256 is stored; the raw token is
  // returned to the client once and never retained.
  await db.schema
    .createTable('oauth_access_tokens')
    .addColumn('token_hash', 'varchar(64)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('client_id', 'varchar(255)', (col) =>
      col.notNull().references('oauth_clients.client_id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    // Which product surface the token authorizes. Only 'jira' today; carried
    // explicitly so a future Confluence/Bitbucket surface can issue and validate
    // tokens independently rather than having every token implicitly mean Jira.
    .addColumn('application', 'varchar(50)', (col) => col.notNull().defaultTo('jira'))
    .addColumn('scope', 'text')
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_oauth_access_tokens_expires_at')
    .on('oauth_access_tokens')
    .column('expires_at')
    .execute();

  // Carries the connecting user across the Atlassian round-trip, so the callback
  // knows whose grant it is stamping. Nullable for in-flight rows created before
  // this migration.
  await db.schema.alterTable('pending_oidc_signin').addColumn('subject', 'varchar(255)').execute();

  // Which signed-in user owns this Jira grant. Nullable because grants created
  // before this migration have no recorded owner: we cannot infer it, and
  // guessing would let one user act as another in Jira. Callers must treat a
  // NULL subject as unusable — the owner re-authenticates once to stamp it.
  await db.schema.alterTable('atlassian_grants').addColumn('subject', 'varchar(255)').execute();

  await db.schema
    .createIndex('idx_atlassian_grants_tenant_subject')
    .on('atlassian_grants')
    .columns(['tenant_id', 'subject'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_atlassian_grants_tenant_subject').execute();
  await db.schema.alterTable('atlassian_grants').dropColumn('subject').execute();
  await db.schema.alterTable('pending_oidc_signin').dropColumn('subject').execute();
  await db.schema.dropIndex('idx_oauth_access_tokens_expires_at').execute();
  await db.schema.dropTable('oauth_access_tokens').execute();
  await db.schema.dropIndex('idx_sessions_expires_at').execute();
  await db.schema.dropTable('sessions').execute();
}

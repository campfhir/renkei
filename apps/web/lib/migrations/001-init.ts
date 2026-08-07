import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Tenants
  await db.schema
    .createTable('tenants')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('slug', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // Tenant OIDC config
  await db.schema
    .createTable('tenant_oidc')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('issuer', 'varchar(255)', (col) => col.notNull())
    .addColumn('client_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('client_secret', 'varchar(255)', (col) => col.notNull())
    .addColumn('role_claim', 'varchar(255)')
    .addColumn('required_role', 'varchar(255)')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('tenant_oidc_tenant_id_unique', ['tenant_id'])
    .execute();

  // Jira sites
  await db.schema
    .createTable('tenant_jira_sites')
    .addColumn('site_id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('cloud_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('jira_url', 'varchar(255)', (col) => col.notNull())
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('claimed_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema.createIndex('idx_tenant_jira_sites_cloud_id').on('tenant_jira_sites').column('cloud_id').execute();

  // Atlassian grants
  await db.schema
    .createTable('atlassian_grants')
    .addColumn('grant_id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('cloud_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('account_display_name', 'varchar(255)')
    .addColumn('encrypted_token', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema.createIndex('idx_grants_cloud_id').on('atlassian_grants').column('cloud_id').execute();
  await db.schema.createIndex('idx_grants_expires_at').on('atlassian_grants').column('expires_at').execute();

  // Operator sessions
  await db.schema
    .createTable('operator_sessions')
    .addColumn('session_id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('operator_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('issued_at', 'timestamp', (col) => col.notNull())
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema.createIndex('idx_operator_sessions_expires_at').on('operator_sessions').column('expires_at').execute();

  // Pending OIDC sign-ins
  await db.schema
    .createTable('pending_oidc_signin')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('state', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('nonce', 'varchar(255)', (col) => col.notNull())
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema.createIndex('idx_pending_signin_state').on('pending_oidc_signin').column('state').execute();

  // Platform audit log
  await db.schema
    .createTable('platform_audit_log')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('event_type', 'varchar(255)', (col) => col.notNull())
    .addColumn('actor_id', 'varchar(255)')
    .addColumn('resource_id', 'varchar(255)')
    .addColumn('details', 'jsonb')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('platform_audit_log').execute();
  await db.schema.dropTable('pending_oidc_signin').execute();
  await db.schema.dropTable('operator_sessions').execute();
  await db.schema.dropTable('atlassian_grants').execute();
  await db.schema.dropTable('tenant_jira_sites').execute();
  await db.schema.dropTable('tenant_oidc').execute();
  await db.schema.dropTable('tenants').execute();
}

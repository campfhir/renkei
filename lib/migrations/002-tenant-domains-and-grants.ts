import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create tenant_domains table for email domain -> tenant mapping
  await db.schema
    .createTable('tenant_domains')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('domain', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema.createIndex('idx_tenant_domains_domain').on('tenant_domains').column('domain').execute();
  await db.schema.createIndex('idx_tenant_domains_tenant_id').on('tenant_domains').column('tenant_id').execute();

  // Drop old atlassian_grants table and recreate with new schema
  await db.schema.dropTable('atlassian_grants').execute();

  await db.schema
    .createTable('atlassian_grants')
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('atlassian_client_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('cloud_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('site_url', 'varchar(255)', (col) => col.notNull())
    .addColumn('operator_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('encrypted_access_token', 'text', (col) => col.notNull())
    .addColumn('encrypted_refresh_token', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('scopes', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('atlassian_grants_pk', ['account_id', 'tenant_id'])
    .execute();

  await db.schema.createIndex('idx_grants_tenant_id').on('atlassian_grants').column('tenant_id').execute();
  await db.schema.createIndex('idx_grants_cloud_id').on('atlassian_grants').column('cloud_id').execute();
  await db.schema.createIndex('idx_grants_expires_at').on('atlassian_grants').column('expires_at').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('atlassian_grants').execute();

  // Recreate old schema
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

  await db.schema.dropTable('tenant_domains').execute();
}

import { Kysely, sql } from 'kysely';

/**
 * Generalise `atlassian_grants` into `provider_grants`.
 *
 * The distinction this table encodes is provider vs product. A provider is
 * whoever issued the OAuth credential (Atlassian, Microsoft); a product is the
 * surface being used (Jira, Confluence, SharePoint, Outlook). They are not the
 * same axis: SharePoint and Outlook are both Microsoft Graph and share one
 * grant, exactly as Jira and Confluence share one Atlassian grant. So provider
 * lives here on the credential, and product lives on the issued MCP access
 * token (`oauth_access_tokens.application`), which is what a caller asks for.
 *
 * Provider-specific fields go in `metadata` rather than becoming columns:
 * Atlassian needs {cloudId, siteUrl}, Microsoft needs {tenantId, upn}, and
 * adding a nullable column per provider would make every row mostly NULL.
 */
export async function up(db: Kysely<never>): Promise<void> {
  await db.schema
    .createTable('provider_grants')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    // 'atlassian' | 'microsoft' | ... — the credential issuer, not the product.
    .addColumn('provider', 'varchar(50)', (col) => col.notNull())
    // The provider's own identifier for the person: Atlassian accountId,
    // Microsoft oid, etc.
    .addColumn('provider_account_id', 'varchar(255)', (col) => col.notNull())
    // Which signed-in user owns this grant. Nullable only so that rows
    // predating per-user ownership can be carried across; callers must treat
    // NULL as unusable rather than guess an owner.
    .addColumn('subject', 'varchar(255)')
    .addColumn('client_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('encrypted_access_token', 'text', (col) => col.notNull())
    .addColumn('encrypted_refresh_token', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('scopes', sql`text[]`, (col) => col.notNull().defaultTo(sql`ARRAY[]::text[]`))
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('provider_grants_pk', ['tenant_id', 'provider', 'provider_account_id'])
    .execute();

  // The hot path: "this signed-in user's grant for this provider".
  await db.schema
    .createIndex('idx_provider_grants_tenant_subject_provider')
    .on('provider_grants')
    .columns(['tenant_id', 'subject', 'provider'])
    .execute();

  await db.schema
    .createIndex('idx_provider_grants_expires_at')
    .on('provider_grants')
    .column('expires_at')
    .execute();

  // Replaces idx_grants_cloud_id. An expression index keeps the old lookup
  // available now that cloudId lives inside metadata.
  await sql`
    CREATE INDEX idx_provider_grants_cloud_id
      ON provider_grants ((metadata->>'cloudId'))
      WHERE provider = 'atlassian'
  `.execute(db);

  await sql`
    INSERT INTO provider_grants (
      tenant_id, provider, provider_account_id, subject, client_id, display_name,
      encrypted_access_token, encrypted_refresh_token, expires_at, scopes, metadata, created_at
    )
    SELECT
      tenant_id,
      'atlassian',
      account_id,
      subject,
      atlassian_client_id,
      COALESCE(NULLIF(operator_name, ''), account_id),
      encrypted_access_token,
      encrypted_refresh_token,
      expires_at,
      scopes,
      jsonb_build_object('cloudId', cloud_id, 'siteUrl', site_url),
      created_at
    FROM atlassian_grants
  `.execute(db);

  await db.schema.dropTable('atlassian_grants').execute();
}

export async function down(db: Kysely<never>): Promise<void> {
  // Recreate the shape 002 left behind, plus the `subject` column 009 added.
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
    .addColumn('scopes', sql`text[]`, (col) => col.notNull().defaultTo(sql`ARRAY[]::text[]`))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('subject', 'varchar(255)')
    .addPrimaryKeyConstraint('atlassian_grants_pk', ['account_id', 'tenant_id'])
    .execute();

  await db.schema
    .createIndex('idx_grants_tenant_id')
    .on('atlassian_grants')
    .column('tenant_id')
    .execute();
  await db.schema
    .createIndex('idx_grants_cloud_id')
    .on('atlassian_grants')
    .column('cloud_id')
    .execute();
  await db.schema
    .createIndex('idx_grants_expires_at')
    .on('atlassian_grants')
    .column('expires_at')
    .execute();
  await db.schema
    .createIndex('idx_atlassian_grants_tenant_subject')
    .on('atlassian_grants')
    .columns(['tenant_id', 'subject'])
    .execute();

  // Only Atlassian rows can round-trip; any other provider has no home in the
  // old schema and is dropped with the table below.
  await sql`
    INSERT INTO atlassian_grants (
      account_id, tenant_id, atlassian_client_id, cloud_id, site_url, operator_name,
      encrypted_access_token, encrypted_refresh_token, expires_at, scopes, created_at, subject
    )
    SELECT
      provider_account_id,
      tenant_id,
      client_id,
      COALESCE(metadata->>'cloudId', ''),
      COALESCE(metadata->>'siteUrl', ''),
      display_name,
      encrypted_access_token,
      encrypted_refresh_token,
      expires_at,
      scopes,
      created_at,
      subject
    FROM provider_grants
    WHERE provider = 'atlassian'
  `.execute(db);

  await db.schema.dropTable('provider_grants').execute();
}

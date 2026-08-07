import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // OAuth clients registered via Dynamic Client Registration (RFC 7591)
  await db.schema
    .createTable('oauth_clients')
    .addColumn('client_id', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('client_secret', 'varchar(255)', (col) => col.notNull())
    .addColumn('client_name', 'varchar(255)')
    .addColumn('redirect_uris', sql`text[]`, (col) => col.notNull()) // array of URIs
    .addColumn('response_types', sql`text[]`, (col) => col.notNull().defaultTo(sql`ARRAY['code']`))
    .addColumn('grant_types', sql`text[]`, (col) =>
      col.notNull().defaultTo(sql`ARRAY['authorization_code', 'refresh_token']`)
    )
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // OAuth authorization codes issued during the authorization flow
  await db.schema
    .createTable('oauth_authorization_codes')
    .addColumn('code', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('client_id', 'varchar(255)', (col) =>
      col.notNull().references('oauth_clients.client_id')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull()) // user or client identifier
    .addColumn('scope', 'text')
    .addColumn('redirect_uri', 'text', (col) => col.notNull())
    .addColumn('code_challenge', 'varchar(255)') // PKCE code_challenge
    .addColumn('code_challenge_method', 'varchar(10)') // S256 or plain
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // OAuth refresh tokens for long-lived client sessions
  await db.schema
    .createTable('oauth_refresh_tokens')
    .addColumn('token_id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('client_id', 'varchar(255)', (col) =>
      col.notNull().references('oauth_clients.client_id')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('scope', 'text')
    .addColumn('encrypted_token', 'text', (col) => col.notNull()) // encrypted refresh token
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_oauth_clients_tenant_id')
    .on('oauth_clients')
    .column('tenant_id')
    .execute();
  await db.schema
    .createIndex('idx_oauth_codes_client_id')
    .on('oauth_authorization_codes')
    .column('client_id')
    .execute();
  await db.schema
    .createIndex('idx_oauth_codes_expires_at')
    .on('oauth_authorization_codes')
    .column('expires_at')
    .execute();
  await db.schema
    .createIndex('idx_oauth_tokens_client_id')
    .on('oauth_refresh_tokens')
    .column('client_id')
    .execute();
  await db.schema
    .createIndex('idx_oauth_tokens_expires_at')
    .on('oauth_refresh_tokens')
    .column('expires_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('oauth_refresh_tokens').execute();
  await db.schema.dropTable('oauth_authorization_codes').execute();
  await db.schema.dropTable('oauth_clients').execute();
}

import { Kysely, sql } from 'kysely';

/**
 * The consent step of the MCP OAuth flow, and the registration default.
 *
 * `oauth_consent_requests` holds an authorization request between the
 * moment the authorize endpoint has validated it and the moment the person
 * answers the consent page: which client asked, where its code must go,
 * the PKCE challenge it committed to, and — the point of the row — WHICH
 * browser session may answer. The code is minted only by a POST from that
 * same session, so a link a signed-in person is lured into clicking shows
 * them a page naming the client instead of silently handing it a token.
 * Rows are single-use and short-lived; `expires_at` bounds an abandoned
 * page, and a session ending takes its pending requests with it.
 *
 * Dynamic client registration (RFC 7591) also moves to off by default for
 * organizations that never set the dial: an open registration endpoint is
 * how an attacker's client gets a client_id to put in that link. Every
 * organization that exists at upgrade time keeps the behaviour it had, so
 * nothing already connected breaks: the old default is written as an
 * explicit setting for each of them, and only a tenant created from now on
 * starts with registration off until an admin turns it on.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('oauth_consent_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('client_id', 'varchar(255)', (col) =>
      col.notNull().references('oauth_clients.client_id').onDelete('cascade')
    )
    .addColumn('session_id', 'uuid', (col) =>
      col.notNull().references('sessions.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('redirect_uri', 'text', (col) => col.notNull())
    .addColumn('state', 'text', (col) => col.notNull())
    .addColumn('scope', 'text')
    .addColumn('code_challenge', 'varchar(255)', (col) => col.notNull())
    .addColumn('code_challenge_method', 'varchar(10)', (col) => col.notNull())
    .addColumn('expires_at', 'timestamp', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_oauth_consent_requests_expires_at')
    .on('oauth_consent_requests')
    .column('expires_at')
    .execute();

  await sql`
    INSERT INTO tenant_settings (tenant_id, key, value)
    SELECT id, 'enable_dcr', 'true'::jsonb FROM tenants
    ON CONFLICT (tenant_id, key) DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The explicit `enable_dcr` rows stay: they record what each organization
  // had, which is also what the previous default gave it.
  await db.schema.dropTable('oauth_consent_requests').execute();
}

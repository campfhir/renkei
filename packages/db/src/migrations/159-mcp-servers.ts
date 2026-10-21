import { Kysely, sql } from 'kysely';

/**
 * Remote MCP servers an admin lists as connectors.
 *
 * The third many-per-organization connector after file shares and Mirth, with
 * one difference that shapes everything: the server, not Renkei, owns
 * authorization. An admin registers WHERE a server is (a URL, how to talk to
 * it, and free text that helps people and the model find it); each person then
 * signs in AT that server through the MCP authorization flow (discovery,
 * dynamic client registration, PKCE), and the resulting tokens are an ordinary
 * `provider_grants` row under provider `mcp:<server id>` — held, refreshed and
 * dialed only by the delegate, like every other token.
 *
 *   - `mcp_servers.slug` is the connector's name as the model sees it: the
 *     tool prefix (`<slug>__<tool>`) and the capability key (`mcp-<slug>`).
 *     It never changes after creation, so a chat's remembered tools and an
 *     admin's switches keep meaning the same server.
 *   - `context` is the admin's additional text — what the server is for,
 *     which systems and vocabulary it covers. It is searched by `find_tools`
 *     and shown to the model next to the server's own tool descriptions.
 *   - `oauth` is what discovery learned (issuer and endpoints); `client_id`
 *     and `encrypted_client_secret` are the registration, obtained by
 *     dynamic registration on first connect or typed in by the admin when the
 *     server offers none.
 *   - `mcp_user_tool_lists` is each person's last `tools/list` answer. A
 *     server may list different tools for different people, and registering
 *     tools performs no I/O, so the list is cached here when the person
 *     connects, refreshes it, or the cache is found stale.
 *   - `pending_oidc_signin.provider` is widened from 32 to 64 characters: a
 *     server's grant provider is `mcp:` plus its uuid (40), and the connect
 *     flow records it there so the shared OAuth callback knows whose it is.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('mcp_servers')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('slug', 'varchar(40)', (col) => col.notNull().unique())
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    .addColumn('url', 'varchar(1024)', (col) => col.notNull())
    // 'streamable_http' | 'sse' (the legacy two-endpoint transport).
    .addColumn('transport', 'varchar(20)', (col) => col.notNull().defaultTo('streamable_http'))
    // 'oauth' (the server authorizes each person) | 'none' (an open server).
    .addColumn('auth_mode', 'varchar(10)', (col) => col.notNull().defaultTo('oauth'))
    .addColumn('context', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('oauth', 'jsonb')
    .addColumn('client_id', 'varchar(512)')
    .addColumn('encrypted_client_secret', 'text')
    .addColumn('scopes', 'text')
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createTable('mcp_user_tool_lists')
    .addColumn('server_id', 'uuid', (col) =>
      col.notNull().references('mcp_servers.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('tools', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('fetched_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('mcp_user_tool_lists_pkey', ['server_id', 'subject'])
    .execute();

  await sql`ALTER TABLE pending_oidc_signin ALTER COLUMN provider TYPE varchar(64)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM pending_oidc_signin WHERE char_length(provider) > 32`.execute(db);
  await sql`ALTER TABLE pending_oidc_signin ALTER COLUMN provider TYPE varchar(32)`.execute(db);
  await db.schema.dropTable('mcp_user_tool_lists').execute();
  await db.schema.dropTable('mcp_servers').execute();
}

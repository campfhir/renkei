import { Kysely, sql } from 'kysely';

/**
 * Carry the caller's renkei roles onto MCP OAuth tokens.
 *
 * Roles were minted once at OIDC sign-in and stored only on the browser
 * session (migration 009's `sessions.roles`) — the MCP authorization-code
 * flow captured `session.subject` when minting a code but dropped
 * `session.roles`, so nothing downstream of an MCP bearer token could tell
 * an operator from a plain user. `oauth_authorize/route.ts` already requires
 * a live browser session to mint a code, so the roles are sitting right
 * there; this just carries them through code → access token → refresh token,
 * the same way `subject` already travels, so a refreshed token keeps the
 * roles it started with rather than losing them on renewal.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('oauth_authorization_codes')
    .addColumn('roles', sql`text[]`, (col) => col.notNull().defaultTo(sql`ARRAY[]::text[]`))
    .execute();

  await db.schema
    .alterTable('oauth_access_tokens')
    .addColumn('roles', sql`text[]`, (col) => col.notNull().defaultTo(sql`ARRAY[]::text[]`))
    .execute();

  await db.schema
    .alterTable('oauth_refresh_tokens')
    .addColumn('roles', sql`text[]`, (col) => col.notNull().defaultTo(sql`ARRAY[]::text[]`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('oauth_refresh_tokens').dropColumn('roles').execute();
  await db.schema.alterTable('oauth_access_tokens').dropColumn('roles').execute();
  await db.schema.alterTable('oauth_authorization_codes').dropColumn('roles').execute();
}

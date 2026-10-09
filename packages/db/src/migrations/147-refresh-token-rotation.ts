import { Kysely, sql } from 'kysely';

/**
 * Refresh-token rotation with reuse detection for the MCP OAuth server
 * (api/mcp/[tenantId]/oauth/token).
 *
 * A refresh token used to live, unchanged, for its whole `expires_at` —
 * every refresh minted a new access token and left the refresh token as it
 * was, so a token lifted from a client's storage kept working for up to
 * thirty days with nothing to notice it. Now every refresh issues a NEW
 * refresh token and marks the presented one `rotated_at`; a rotated token
 * presented again is the reuse signal (either the client or the thief
 * holds a copy it should not), and the whole `family_id` — every token
 * descended from the same authorization — is revoked along with the
 * subject's access tokens for that client.
 *
 * Existing rows each become their own family, so nothing in flight breaks;
 * their next refresh rotates them like any other.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('oauth_refresh_tokens')
    .addColumn('family_id', 'uuid', (col) => col.notNull().defaultTo(sql`gen_random_uuid()`))
    .execute();
  await db.schema
    .alterTable('oauth_refresh_tokens')
    .addColumn('rotated_at', 'timestamptz')
    .execute();
  await db.schema
    .createIndex('idx_oauth_refresh_tokens_family')
    .on('oauth_refresh_tokens')
    .columns(['tenant_id', 'family_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_oauth_refresh_tokens_family').execute();
  await sql`DELETE FROM oauth_refresh_tokens WHERE rotated_at IS NOT NULL`.execute(db);
  await db.schema.alterTable('oauth_refresh_tokens').dropColumn('rotated_at').execute();
  await db.schema.alterTable('oauth_refresh_tokens').dropColumn('family_id').execute();
}

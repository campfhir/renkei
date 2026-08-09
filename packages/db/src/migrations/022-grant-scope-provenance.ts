import { Kysely, sql } from 'kysely';

/**
 * Split grant scope provenance into what the flow ASKED for and what the
 * provider actually MINTED.
 *
 * The old single `scopes` column blurred the two: the callback stored the
 * token response's echo when present, else the request — so "the scope is in
 * the DB" proved nothing when Atlassian answered "scope does not match".
 * `requested_scopes` carries the (possibly user-narrowed) authorize request;
 * `granted_scopes` is decoded from the access token's own claims and NULL
 * when the token is opaque (WebEx) — unknown, never assumed.
 *
 * Existing rows keep their value as requested_scopes: that is the only
 * reading that was always true of them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('provider_grants')
    .renameColumn('scopes', 'requested_scopes')
    .execute();
  await db.schema
    .alterTable('provider_grants')
    .addColumn('granted_scopes', sql`text[]`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('provider_grants').dropColumn('granted_scopes').execute();
  await db.schema
    .alterTable('provider_grants')
    .renameColumn('requested_scopes', 'scopes')
    .execute();
}

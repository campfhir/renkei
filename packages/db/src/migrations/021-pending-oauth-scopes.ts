import { Kysely } from 'kysely';

/**
 * The scopes an OAuth flow actually requested, carried through the state
 * round-trip. A user may narrow the org's scope ceiling at the authorize
 * step; the callback must record the narrowed set on the grant, and not
 * every provider echoes scopes in its token response (WebEx does not) — so
 * the pending row remembers what was asked.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pending_oidc_signin').addColumn('scopes', 'text').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pending_oidc_signin').dropColumn('scopes').execute();
}

import { Kysely } from 'kysely';

/**
 * PKCE support for provider OAuth flows (first consumer: OnBase).
 *
 * Authorization Code with PKCE needs the code_verifier to survive the
 * round-trip through the provider's authorize page: the authorize route
 * mints it, the callback must present the exact same value to the token
 * endpoint. `pending_oidc_signin` is already the single-use state row that
 * carries a flow across that redirect, but none of its columns can honestly
 * hold the verifier — `nonce` is consumed by OIDC sign-in validation and
 * `scopes` is read verbatim into `requested_scopes` by every callback
 * branch. So the verifier gets its own column, NULL for the providers that
 * do not use PKCE. RFC 7636 caps the verifier at 128 characters, so
 * varchar(255) is roomy.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pending_oidc_signin').addColumn('code_verifier', 'varchar(255)').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pending_oidc_signin').dropColumn('code_verifier').execute();
}

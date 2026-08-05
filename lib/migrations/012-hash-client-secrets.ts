import { Kysely, sql } from 'kysely';

/**
 * Stop storing issued OAuth client secrets in readable form.
 *
 * `oauth_clients.client_secret` held the secret verbatim. Anyone who could read
 * the table held every registered client's credentials, and since dynamic
 * client registration is open, those credentials are what the token endpoint
 * checks before exchanging an authorization code.
 *
 * Hashed rather than encrypted, for the same reason as the refresh tokens in
 * migration 011: the server issues the secret once, in the registration
 * response, and from then on only ever compares a presented value against it.
 * Nothing needs the original back, so a digest gives up nothing and cannot be
 * reversed by whoever reads the table.
 *
 * Note this is a different case from `tenant_oidc.client_secret`, which stays
 * AES-encrypted: that one is replayed to the tenant's identity provider, so the
 * plaintext has to be recoverable.
 */
export async function up(db: Kysely<never>): Promise<void> {
  await db.schema
    .alterTable('oauth_clients')
    .renameColumn('client_secret', 'client_secret_hash')
    .execute();

  // Digest what is already on disk rather than dropping rows, so registered
  // clients keep working without re-registering. Must match `hashToken` in
  // lib/mcp-token.ts: SHA-256 over the secret's UTF-8 bytes, lowercase hex.
  await sql`
    UPDATE oauth_clients
    SET client_secret_hash = encode(sha256(convert_to(client_secret_hash, 'UTF8')), 'hex')
  `.execute(db);
}

export async function down(db: Kysely<never>): Promise<void> {
  // A hash cannot be turned back into the secret it came from. Rather than
  // leave digests in a column the old code compares against a presented secret
  // -- where every exchange fails against a credential that looks present --
  // drop the clients and make them register again.
  //
  // Ordered by dependency: tokens and codes reference the client.
  await sql`DELETE FROM oauth_access_tokens`.execute(db);
  await sql`DELETE FROM oauth_refresh_tokens`.execute(db);
  await sql`DELETE FROM oauth_authorization_codes`.execute(db);
  await sql`DELETE FROM oauth_clients`.execute(db);

  await db.schema
    .alterTable('oauth_clients')
    .renameColumn('client_secret_hash', 'client_secret')
    .execute();
}

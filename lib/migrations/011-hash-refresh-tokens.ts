import { Kysely, sql } from 'kysely';

/**
 * Stop storing MCP refresh tokens in readable form.
 *
 * The column was named `encrypted_token` but held the token verbatim — both
 * token routes wrote the plaintext and then looked rows up by it. A read of
 * this table handed over every live refresh token, and each one buys a fresh
 * access token, which is full use of that user's Jira grant.
 *
 * These are hashed rather than encrypted. The server never needs the value
 * back: it issues the token once and afterwards only checks whether what a
 * client presented matches what was issued. That is the same shape as a
 * password, and the same answer applies — a digest cannot be reversed by
 * whoever reads the table, whereas ciphertext plus the key can. It also keeps
 * the lookup a plain indexed equality on the digest, which encryption would
 * have broken (AES-GCM is randomised, so the same token encrypts differently
 * every time and `WHERE encrypted_token = ?` would never match).
 *
 * Atlassian's refresh tokens are a genuinely different case and stay encrypted
 * in `provider_grants`: those get replayed to Atlassian, so the plaintext has
 * to be recoverable.
 */
export async function up(db: Kysely<never>): Promise<void> {
  await db.schema
    .alterTable('oauth_refresh_tokens')
    .renameColumn('encrypted_token', 'token_hash')
    .execute();

  // Digest the tokens already on disk instead of deleting them, so live
  // clients keep working. Must match lib/mcp-token.ts `hashToken`: SHA-256 over
  // the token's UTF-8 bytes, lowercase hex.
  await sql`
    UPDATE oauth_refresh_tokens
    SET token_hash = encode(sha256(convert_to(token_hash, 'UTF8')), 'hex')
  `.execute(db);

  // A digest collision would let one client's token authenticate as another's.
  // Unique also gives the lookup an index it did not have before.
  await db.schema
    .createIndex('idx_oauth_refresh_tokens_token_hash')
    .on('oauth_refresh_tokens')
    .column('token_hash')
    .unique()
    .execute();
}

export async function down(db: Kysely<never>): Promise<void> {
  await db.schema.dropIndex('idx_oauth_refresh_tokens_token_hash').execute();

  // A hash cannot be turned back into the token it came from. Rather than leave
  // digests sitting in a column the old code reads as plaintext — where every
  // refresh silently fails against a token that looks present — drop the rows
  // and make clients re-authenticate.
  await sql`DELETE FROM oauth_refresh_tokens`.execute(db);

  await db.schema
    .alterTable('oauth_refresh_tokens')
    .renameColumn('token_hash', 'encrypted_token')
    .execute();
}

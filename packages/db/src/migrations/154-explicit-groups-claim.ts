import { Kysely, sql } from 'kysely';

/**
 * Nobody is in a group by default.
 *
 * Sign-in used to read the conventional `groups` claim whenever
 * `oidc_config.groups_claim` was NULL. It no longer assumes any claim: with
 * none configured a person is in no groups, and a connector scoped to an
 * audience is open to nobody until an operator names the claim (Settings →
 * Identity). A deployment that has been reading `groups` all along keeps
 * doing so — the implicit default becomes the explicit value, which the
 * operator can now see and clear.
 *
 * The first-run setup secret moved from a digest in `settings` (minted into
 * the server log) to the SETUP_SECRET environment variable; the rows the
 * old mechanism may have left behind go.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE oidc_config SET groups_claim = 'groups' WHERE groups_claim IS NULL`.execute(db);
  await sql`DELETE FROM settings WHERE key IN ('setup_secret_hash', 'setup_secret_expires_at')`.execute(
    db
  );
}

export async function down(): Promise<void> {
  // The explicit value is what the implicit default meant; leaving it is the
  // faithful reversal. The setup-secret rows were one-time state.
}

import { Kysely, sql } from 'kysely';

/**
 * The deployment's delegate signing key (docs/delegate-key-design.md,
 * "Which delegate am I sealing to?").
 *
 * A browser seals a person's key to whatever instance public keys the web
 * app hands it, which is exactly the thing a compromised web app would
 * forge. The browser now remembers the instance keys it has sealed to and
 * accepts a NEW one without asking only when the live-instance list is
 * signed by a key it already trusts; otherwise it names the fingerprint
 * and asks the person. That signing key is per deployment, made by the
 * first delegate to boot and shared by every instance: one row, the
 * Ed25519 public half in the clear and the private half sealed under
 * TOKEN_ENCRYPTION_KEY (an org-level secret, like the connector client
 * secrets it already guards). The `singleton` column keeps it to one row
 * when two instances boot at once.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE delegate_signing_keys (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      singleton          BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton),
      public_key         TEXT NOT NULL,
      sealed_private_key TEXT NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS delegate_signing_keys`.execute(db);
}

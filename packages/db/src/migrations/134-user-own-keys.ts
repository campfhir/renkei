import { Kysely, sql } from 'kysely';

/**
 * Bring-your-own-key (docs/user-encryption-keys-design.md, "Your own key").
 *
 * A person may replace the managed key-encryption key (derived from the
 * deployment master and their salt, 133) with one derived from a
 * passphrase only they hold. `mode` says which they are on. For `own`:
 *
 * - `verifier` is a one-way tag of the KEK, so an unlock can check the
 *   passphrase without the KEK being stored anywhere.
 * - `sealed_kek` / `unlocked_until` are the UNLOCK WINDOW: after the
 *   person enters their passphrase, the derived KEK is kept sealed under
 *   a master-derived key until `unlocked_until`, so every process (the
 *   web app's turns, the workers' token refreshes) can use it while they
 *   are working; past that moment, or once the row is locked, the two
 *   columns are cleared and nothing Renkei stores can produce the key.
 *
 * Managed rows carry NULLs here and derive as before.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('user_encryption_keys')
    .addColumn('mode', 'varchar(16)', (col) => col.notNull().defaultTo('managed'))
    .execute();
  await db.schema.alterTable('user_encryption_keys').addColumn('verifier', 'varchar(64)').execute();
  await db.schema.alterTable('user_encryption_keys').addColumn('sealed_kek', 'text').execute();
  await db.schema
    .alterTable('user_encryption_keys')
    .addColumn('unlocked_until', 'timestamptz')
    .execute();
  await sql`
    ALTER TABLE user_encryption_keys
      ADD CONSTRAINT user_encryption_keys_mode CHECK (mode IN ('managed', 'own'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE user_encryption_keys DROP CONSTRAINT user_encryption_keys_mode`.execute(db);
  await db.schema.alterTable('user_encryption_keys').dropColumn('unlocked_until').execute();
  await db.schema.alterTable('user_encryption_keys').dropColumn('sealed_kek').execute();
  await db.schema.alterTable('user_encryption_keys').dropColumn('verifier').execute();
  await db.schema.alterTable('user_encryption_keys').dropColumn('mode').execute();
}

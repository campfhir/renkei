import { Kysely } from 'kysely';

/**
 * SFTP host-key pinning for file shares (docs/fileshares-connector-design.md,
 * "Host keys"). `host_key_fingerprint` holds the server's SSH host key as
 * an OpenSSH-style `SHA256:<base64>` fingerprint — entered by an admin on
 * the share form, or recorded on the first successful connection
 * (trust-on-first-use) and shown to the admin to confirm. Every later SFTP
 * connection refuses a server presenting a different key. NULL for an SMB
 * share, and for an SFTP share no one has connected to yet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('file_shares')
    .addColumn('host_key_fingerprint', 'varchar(64)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('file_shares').dropColumn('host_key_fingerprint').execute();
}

import { Kysely, sql } from 'kysely';

/**
 * Copy links are gone: the markdown export (a document ending in the
 * agent's exact definition) replaced them — it carries everything the
 * shared page showed, needs no standing URL to mint or revoke, and
 * imports on the receiving side through the same validated save path as
 * every other create. With the routes and pages deleted, a stored token
 * is a credential nothing reads; dropping the column retires it rather
 * than leaving secrets-shaped data at rest.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_agents_share_token`.execute(db);
  await db.schema.alterTable('agents').dropColumn('share_token').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agents').addColumn('share_token', 'varchar(64)').execute();
  await sql`
    CREATE UNIQUE INDEX idx_agents_share_token
    ON agents (share_token)
    WHERE share_token IS NOT NULL
  `.execute(db);
}

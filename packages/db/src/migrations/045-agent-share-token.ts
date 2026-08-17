import { Kysely, sql } from 'kysely';

/**
 * Shareable agents: `share_token` names an agent's copy link. The owner
 * mints one (or clears it — NULL = not shared); anyone SIGNED INTO THE
 * SAME TENANT holding the link can view the agent's configuration and
 * copy it into an agent of their own. The copy is a fork — new owner, new
 * ids, born disabled — never a reference back.
 *
 * Stored plaintext, deliberately breaking the digest-only rule the token
 * tables follow: the owner must be able to RE-DISPLAY the link (a
 * shown-once share link would be re-minted on every glance, invalidating
 * what teammates already hold), and the capability it grants is reading a
 * config that a database leak would expose directly anyway — unlike a
 * bearer credential, the token is worth nothing more than the row next to
 * it. It still gates nothing without a session in the same tenant.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('agents').addColumn('share_token', 'varchar(64)').execute();

  // The shared-page lookup, and one link per token across the deployment.
  await sql`
    CREATE UNIQUE INDEX idx_agents_share_token
    ON agents (share_token)
    WHERE share_token IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_agents_share_token`.execute(db);
  await db.schema.alterTable('agents').dropColumn('share_token').execute();
}

import { Kysely, sql } from 'kysely';

/**
 * Sandbox scratch space by where the work happens, not only by whom.
 * Until now a staged file was keyed by its subject alone, so a file staged
 * in one chat was listed, read and brought back from every other chat the
 * same person had. `sandbox_files.scope` names the place a file was staged
 * from — `chat:<id>`, or `project:<id>` for a code project whose chats
 * share one checkout — and every per-caller read matches it as well as
 * the subject. '' is the person's own scratch space: an MCP client outside
 * any chat, and every row staged before this migration. The quota stays
 * per subject.
 *
 * `oauth_access_tokens.sandbox_scope` is the scope a run token was minted
 * for (a chat turn's), so the MCP endpoint's sandbox tools stage and read
 * there; null for every other token.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('sandbox_files')
    .addColumn('scope', 'varchar(64)', (col) => col.notNull().defaultTo(''))
    .execute();
  await db.schema
    .createIndex('idx_sandbox_files_subject_scope')
    .on('sandbox_files')
    .columns(['subject', 'scope', 'created_at'])
    .execute();
  await db.schema
    .alterTable('oauth_access_tokens')
    .addColumn('sandbox_scope', 'varchar(64)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_sandbox_files_subject_scope`.execute(db);
  await db.schema.alterTable('sandbox_files').dropColumn('scope').execute();
  await db.schema.alterTable('oauth_access_tokens').dropColumn('sandbox_scope').execute();
}

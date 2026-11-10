import { Kysely, sql } from 'kysely';

/**
 * Prompt library scope: where a library's prompts are offered.
 *
 * `any` (every existing library) shows in every chat's picker; `code` shows
 * only in a code project's chat, so development prompts do not crowd the
 * picker in ordinary chats and vice versa. A flag on the library, not a
 * project link: one library serves every code project its readers open.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE prompt_libraries
      ADD COLUMN scope varchar(16) NOT NULL DEFAULT 'any'
        CONSTRAINT prompt_libraries_scope_check CHECK (scope IN ('any', 'code'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE prompt_libraries DROP COLUMN scope`.execute(db);
}

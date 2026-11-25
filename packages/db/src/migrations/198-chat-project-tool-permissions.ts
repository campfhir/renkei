import { Kysely, sql } from 'kysely';

/**
 * `chat_projects.tool_permissions` — a chat project's (or code project's)
 * own tool settings for its chats (apps/web/lib/chat/project-permissions.ts):
 * `{ allow: string[], ask: string[] }` — act tools that run without asking
 * in its chats, and read tools made to ask. A chat can still block or ask
 * for itself, and the organization's locked high-risk tools ask whatever
 * this says. Null until the first setting.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chat_projects').addColumn('tool_permissions', 'jsonb').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE chat_projects DROP COLUMN tool_permissions`.execute(db);
}

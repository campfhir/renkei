import { Kysely, sql } from 'kysely';

/**
 * `chats.tool_permissions` — what the owner decided about a tool for this
 * one chat from its permission card: "Allow in this chat" and "Block in
 * this chat" (apps/web/lib/chat/chat-permissions.ts). `{ allow: string[],
 * deny: string[] }`; null until the first such answer. Kept on the chat
 * so it goes with it, and never reaches the person's other chats, which
 * their own lists under Preferences decide.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chats').addColumn('tool_permissions', 'jsonb').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE chats DROP COLUMN tool_permissions`.execute(db);
}

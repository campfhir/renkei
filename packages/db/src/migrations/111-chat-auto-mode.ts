import { Kysely, sql } from 'kysely';

/**
 * `chats.auto_mode` — the chat works unattended (apps/web/lib/chat/auto-mode.ts):
 * its act tools run without asking, and a turn that ends without the
 * model marking the task complete is carried on by the runner itself
 * until it does, or gives up. A per-chat switch like `thinking_enabled`,
 * kept on the row so every turn — and every replica — reads the same
 * answer; only a code project's chats honour it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chats')
    .addColumn('auto_mode', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE chats DROP COLUMN auto_mode`.execute(db);
}

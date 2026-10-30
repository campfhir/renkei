import { Kysely, sql } from 'kysely';

/**
 * `chats.temporary` — a chat started as temporary: it gets none of the
 * person's memories, and after a day without activity it is deleted, not
 * archived (apps/worker-agents/src/chat-sweep.ts). The index serves that
 * sweep, which reads only temporary chats.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chats')
    .addColumn('temporary', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
  await sql`CREATE INDEX chats_temporary_updated_idx ON chats (updated_at) WHERE temporary`.execute(
    db
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS chats_temporary_updated_idx`.execute(db);
  await sql`ALTER TABLE chats DROP COLUMN temporary`.execute(db);
}

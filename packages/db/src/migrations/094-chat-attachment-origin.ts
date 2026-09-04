import { Kysely, sql } from 'kysely';

/**
 * Where a chat attachment came from. `upload` is a person's file; `model`
 * is a file a tool handed back during a turn — a screenshot, a rendered
 * PDF, a download — kept so the chat can list what the model produced
 * ("artifacts") and hand the bytes back on request. Model files hang off
 * the tool-results row that carried them, and go with it when a message
 * is resent and the replies after it are removed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chat_attachments')
    .addColumn('origin', 'varchar(16)', (col) => col.notNull().defaultTo('upload'))
    .execute();
  await sql`
    ALTER TABLE chat_attachments
      ADD CONSTRAINT chat_attachments_origin CHECK (origin IN ('upload', 'model'))
  `.execute(db);
  await sql`
    CREATE INDEX idx_chat_attachments_artifacts
      ON chat_attachments (chat_id, created_at) WHERE origin = 'model'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_chat_attachments_artifacts`.execute(db);
  await db.schema.alterTable('chat_attachments').dropColumn('origin').execute();
}

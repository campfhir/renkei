import { Kysely, sql } from 'kysely';

/**
 * One active chat per code project.
 *
 * A code project has one checkout on one branch, shared by every chat in
 * it (102, docs/sandbox-workspaces-design.md), so two chats working in it
 * at once step on each other's uncommitted changes and branch switches.
 * Rather than a checkout per chat, the project keeps ONE chat that may
 * continue — `active_chat_id` — and every other chat in it is history:
 * still there to read, never to send in. Starting a new chat in the
 * project makes it the active one and the previous one history; that is
 * the only way the column moves forward. Deleting the active chat leaves
 * the project with none until the next new chat (the reference is
 * cleared with the row); archiving it does the same (chat store).
 *
 * The column is meaningless on a chat project (`kind = 'chat'`), whose
 * chats are independent conversations sharing context; it stays null
 * there. Existing code projects are backfilled with their most recently
 * touched open chat, so nothing anyone is working in goes read-only on
 * upgrade.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('chat_projects')
    .addColumn('active_chat_id', 'uuid', (col) => col.references('chats.id').onDelete('set null'))
    .execute();
  await sql`
    UPDATE chat_projects p
       SET active_chat_id = latest.id
      FROM (
        SELECT DISTINCT ON (project_id) id, project_id
          FROM chats
         WHERE project_id IS NOT NULL AND archived_at IS NULL
         ORDER BY project_id, updated_at DESC, created_at DESC
      ) latest
     WHERE latest.project_id = p.id AND p.kind = 'code'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('chat_projects').dropColumn('active_chat_id').execute();
}

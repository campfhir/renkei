import { Kysely, sql } from 'kysely';

/**
 * A worktree per code chat.
 *
 * Migration 119 let a code project have one active chat because the
 * project had one checkout on one branch, and two chats editing it at once
 * stepped on each other. Each chat now gets its own `git worktree` off the
 * project's base clone (docs/sandbox-workspaces-design.md), so chats in a
 * project run concurrently and `active_chat_id` stops meaning anything: the
 * column goes.
 *
 * A worktree is a `sandbox_workspaces` row of its own — every worker verb
 * already works by workspace id — whose `parent_id` names the base clone it
 * hangs off (null for a clone). `chats.workspace_id` is the chat's
 * worktree; null until its first turn makes one, and for every chat that
 * is not in a code project. Both are soft references: the sandbox worker
 * owns the rows, and a worktree it no longer has is made again.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('sandbox_workspaces').addColumn('parent_id', 'uuid').execute();
  await db.schema.alterTable('chats').addColumn('workspace_id', 'uuid').execute();
  await db.schema.alterTable('chat_projects').dropColumn('active_chat_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
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
  await db.schema.alterTable('chats').dropColumn('workspace_id').execute();
  await db.schema.alterTable('sandbox_workspaces').dropColumn('parent_id').execute();
}

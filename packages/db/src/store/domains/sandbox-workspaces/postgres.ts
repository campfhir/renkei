import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { sandboxWorkspaceFromRow, sandboxWorkspaceValues, sizeAndBranch } from './record';
import type { SandboxWorkspaceStore } from './types';

export function postgresSandboxWorkspaces(db: () => Kysely<DB>): SandboxWorkspaceStore {
  return {
    async insert(workspace) {
      const row = await db()
        .insertInto('sandbox_workspaces')
        .values(sandboxWorkspaceValues(workspace))
        .returningAll()
        .executeTakeFirstOrThrow();
      return sandboxWorkspaceFromRow(row);
    },
    async list(subject) {
      const rows = await db()
        .selectFrom('sandbox_workspaces')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .execute();
      return rows.map(sandboxWorkspaceFromRow);
    },
    async count(subject, worktrees) {
      const row = await db()
        .selectFrom('sandbox_workspaces')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('subject', '=', subject)
        .where('parent_id', worktrees ? 'is not' : 'is', null)
        .executeTakeFirst();
      return row?.count ? Number(row.count) : 0;
    },
    async get(subject, id) {
      const row = await db()
        .selectFrom('sandbox_workspaces')
        .selectAll()
        .where('subject', '=', subject)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? sandboxWorkspaceFromRow(row) : null;
    },
    async setStatus(id, status, change) {
      await db()
        .updateTable('sandbox_workspaces')
        .set({ status, error: change.error, ...sizeAndBranch(change) })
        .where('id', '=', id)
        .execute();
    },
    async listWorktrees(subject, parentId) {
      const rows = await db()
        .selectFrom('sandbox_workspaces')
        .selectAll()
        .where('subject', '=', subject)
        .where('parent_id', '=', parentId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(sandboxWorkspaceFromRow);
    },
    async touch(id, change) {
      await db()
        .updateTable('sandbox_workspaces')
        .set({ expires_at: change.expiresAt })
        .where((eb) =>
          eb(
            'id',
            '=',
            eb.selectFrom('sandbox_workspaces').select('parent_id').where('id', '=', id)
          )
        )
        .execute();
      await db()
        .updateTable('sandbox_workspaces')
        .set({
          last_used_at: change.lastUsedAt,
          expires_at: change.expiresAt,
          ...sizeAndBranch(change),
        })
        .where('id', '=', id)
        .execute();
    },
    async delete(subject, id) {
      const row = await db()
        .deleteFrom('sandbox_workspaces')
        .where('subject', '=', subject)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row ? sandboxWorkspaceFromRow(row) : null;
    },
    async listExpired(before, limit) {
      const rows = await db()
        .selectFrom('sandbox_workspaces')
        .selectAll()
        .where('expires_at', '<', before)
        .orderBy('expires_at')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(sandboxWorkspaceFromRow);
    },
    async deleteById(id) {
      await db().deleteFrom('sandbox_workspaces').where('id', '=', id).execute();
    },
    async getById(id) {
      const row = await db()
        .selectFrom('sandbox_workspaces')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? sandboxWorkspaceFromRow(row) : null;
    },
    async listWorktreesOf(parentId) {
      const rows = await db()
        .selectFrom('sandbox_workspaces')
        .selectAll()
        .where('parent_id', '=', parentId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(sandboxWorkspaceFromRow);
    },
  };
}

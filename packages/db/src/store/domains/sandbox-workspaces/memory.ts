import { orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { sandboxWorkspaceFromRow, sandboxWorkspaceValues, sizeAndBranch } from './record';
import type { SandboxWorkspaceStore } from './types';

type WorkspaceRow = Row<'sandbox_workspaces'>;

const oldestFirst = (rows: WorkspaceRow[]) =>
  orderBy(rows, [(r) => r.created_at], [(r) => r.id]).map(sandboxWorkspaceFromRow);

export function memorySandboxWorkspaces(tables: MemoryTables): SandboxWorkspaceStore {
  const id = (value: string) => tables.param('sandbox_workspaces', 'id', value);
  return {
    async insert(workspace) {
      return sandboxWorkspaceFromRow(
        tables.insert('sandbox_workspaces', sandboxWorkspaceValues(workspace))
      );
    },
    async list(subject) {
      const rows = tables.select('sandbox_workspaces', (r) => r.subject === subject);
      return orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]).map(
        sandboxWorkspaceFromRow
      );
    },
    async count(subject, worktrees) {
      return tables.select(
        'sandbox_workspaces',
        (r) => r.subject === subject && (r.parent_id !== null) === worktrees
      ).length;
    },
    async get(subject, workspaceId) {
      const wanted = id(workspaceId);
      const row = tables.first(
        'sandbox_workspaces',
        (r) => r.subject === subject && r.id === wanted
      );
      return row ? sandboxWorkspaceFromRow(row) : null;
    },
    async setStatus(workspaceId, status, change) {
      const wanted = id(workspaceId);
      tables.update('sandbox_workspaces', (r) => r.id === wanted, {
        status,
        error: change.error,
        ...sizeAndBranch(change),
      });
    },
    async listWorktrees(subject, parentId) {
      const wanted = id(parentId);
      return oldestFirst(
        tables.select('sandbox_workspaces', (r) => r.subject === subject && r.parent_id === wanted)
      );
    },
    async touch(workspaceId, change) {
      const wanted = id(workspaceId);
      const parent = tables.first('sandbox_workspaces', (r) => r.id === wanted)?.parent_id;
      if (parent) {
        tables.update('sandbox_workspaces', (r) => r.id === parent, {
          expires_at: change.expiresAt,
        });
      }
      tables.update('sandbox_workspaces', (r) => r.id === wanted, {
        last_used_at: change.lastUsedAt,
        expires_at: change.expiresAt,
        ...sizeAndBranch(change),
      });
    },
    async delete(subject, workspaceId) {
      const wanted = id(workspaceId);
      const [row] = tables.delete(
        'sandbox_workspaces',
        (r) => r.subject === subject && r.id === wanted
      );
      return row ? sandboxWorkspaceFromRow(row) : null;
    },
    async listExpired(before, limit) {
      const rows = tables.select(
        'sandbox_workspaces',
        (r) => r.expires_at.getTime() < before.getTime()
      );
      return page(orderBy(rows, [(r) => r.expires_at], [(r) => r.id]), limit).map(
        sandboxWorkspaceFromRow
      );
    },
    async deleteById(workspaceId) {
      const wanted = id(workspaceId);
      tables.delete('sandbox_workspaces', (r) => r.id === wanted);
    },
    async getById(workspaceId) {
      const wanted = id(workspaceId);
      const row = tables.first('sandbox_workspaces', (r) => r.id === wanted);
      return row ? sandboxWorkspaceFromRow(row) : null;
    },
    async listWorktreesOf(parentId) {
      const wanted = id(parentId);
      return oldestFirst(tables.select('sandbox_workspaces', (r) => r.parent_id === wanted));
    },
  };
}

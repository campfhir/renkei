import { orderBy } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { grantFromRow, tableOfKind } from './record';
import type { ResourceGrantStore } from './types';

type Grant = Row<'resource_access_grants'>;

function active(row: Grant, now: Date): boolean {
  return row.expires_at === null || row.expires_at.getTime() > now.getTime();
}

export function memoryResourceGrants(tables: MemoryTables): ResourceGrantStore {
  const resource = (value: string) => tables.param('resource_access_grants', 'resource_id', value);
  const oldestFirst = (rows: Grant[]) => orderBy(rows, [(r) => r.created_at], [(r) => r.id]);

  return {
    async ownerOf(kind, resourceId) {
      const table = tableOfKind(kind);
      const id = tables.param(table, 'id', resourceId);
      const row =
        table === 'chats'
          ? tables.first('chats', (r) => r.id === id)
          : table === 'chat_projects'
            ? tables.first('chat_projects', (r) => r.id === id)
            : table === 'artifacts'
              ? tables.first('artifacts', (r) => r.id === id)
              : tables.first('prompt_libraries', (r) => r.id === id);
      return row?.owner_subject ?? null;
    },
    async activeRole(kind, resourceId, granteeSubject) {
      const id = resource(resourceId);
      const now = new Date();
      const row = tables.first(
        'resource_access_grants',
        (r) =>
          r.resource_kind === kind &&
          r.resource_id === id &&
          r.grantee_subject === granteeSubject &&
          active(r, now)
      );
      return row?.role ?? null;
    },
    async listForGrantee(granteeSubject, kind) {
      const now = new Date();
      return oldestFirst(
        tables.select(
          'resource_access_grants',
          (r) => r.resource_kind === kind && r.grantee_subject === granteeSubject && active(r, now)
        )
      ).map(grantFromRow);
    },
    async activeGrantees(kind, resourceId) {
      const id = resource(resourceId);
      const now = new Date();
      return oldestFirst(
        tables.select(
          'resource_access_grants',
          (r) => r.resource_kind === kind && r.resource_id === id && active(r, now)
        )
      ).map((r) => r.grantee_subject);
    },
    async upsert(grant) {
      tables.upsert(
        'resource_access_grants',
        {
          resource_kind: grant.resourceKind,
          resource_id: grant.resourceId,
          owner_subject: grant.ownerSubject,
          grantee_subject: grant.granteeSubject,
          role: grant.role,
          expires_at: grant.expiresAt,
        },
        ['resource_kind', 'resource_id', 'grantee_subject'],
        { role: grant.role, expires_at: grant.expiresAt }
      );
    },
    async listForOwner(ownerSubject, kind, resourceId) {
      const id = resource(resourceId);
      const rows = orderBy(
        tables.select(
          'resource_access_grants',
          (r) =>
            r.resource_kind === kind && r.resource_id === id && r.owner_subject === ownerSubject
        ),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
      return rows.map((row) => {
        const identity = tables.first('identities', (i) => i.subject === row.grantee_subject);
        return {
          ...grantFromRow(row),
          granteeName: identity?.display_name ?? null,
          granteeEmail: identity?.email ?? null,
        };
      });
    },
    async revoke(ownerSubject, kind, resourceId, grantId) {
      const id = resource(resourceId);
      const grant = tables.param('resource_access_grants', 'id', grantId);
      const [deleted] = tables.delete(
        'resource_access_grants',
        (r) =>
          r.resource_kind === kind &&
          r.resource_id === id &&
          r.owner_subject === ownerSubject &&
          r.id === grant
      );
      return deleted?.grantee_subject ?? null;
    },
    async removeGrantee(kind, resourceId, granteeSubject) {
      const id = resource(resourceId);
      return tables.delete(
        'resource_access_grants',
        (r) =>
          r.resource_kind === kind && r.resource_id === id && r.grantee_subject === granteeSubject
      ).length;
    },
    async deleteForResource(kind, resourceId) {
      const id = resource(resourceId);
      return tables.delete(
        'resource_access_grants',
        (r) => r.resource_kind === kind && r.resource_id === id
      ).length;
    },
    async countActive(kind, resourceIds) {
      if (resourceIds.length === 0) return [];
      const ids = new Set(resourceIds.map(resource));
      const now = new Date();
      const counts = new Map<string, number>();
      for (const row of tables.select(
        'resource_access_grants',
        (r) => r.resource_kind === kind && ids.has(r.resource_id) && active(r, now)
      )) {
        counts.set(row.resource_id, (counts.get(row.resource_id) ?? 0) + 1);
      }
      return orderBy([...counts], [([id]) => id]).map(([resourceId, count]) => ({
        resourceId,
        count,
      }));
    },
  };
}

import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { grantFromRow, tableOfKind } from './record';
import type { ResourceGrantStore } from './types';

export function postgresResourceGrants(db: () => Kysely<DB>): ResourceGrantStore {
  return {
    async ownerOf(kind, resourceId) {
      const row = await db()
        .selectFrom(tableOfKind(kind))
        .select('owner_subject')
        .where('id', '=', resourceId)
        .executeTakeFirst();
      return row?.owner_subject ?? null;
    },
    async activeRole(kind, resourceId, granteeSubject) {
      const row = await db()
        .selectFrom('resource_access_grants')
        .select('role')
        .where('resource_kind', '=', kind)
        .where('resource_id', '=', resourceId)
        .where('grantee_subject', '=', granteeSubject)
        .where((eb) =>
          eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`NOW()`)])
        )
        .executeTakeFirst();
      return row?.role ?? null;
    },
    async listForGrantee(granteeSubject, kind) {
      const rows = await db()
        .selectFrom('resource_access_grants')
        .selectAll()
        .where('resource_kind', '=', kind)
        .where('grantee_subject', '=', granteeSubject)
        .where((eb) =>
          eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`NOW()`)])
        )
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(grantFromRow);
    },
    async activeGrantees(kind, resourceId) {
      const rows = await db()
        .selectFrom('resource_access_grants')
        .select('grantee_subject')
        .where('resource_kind', '=', kind)
        .where('resource_id', '=', resourceId)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map((row) => row.grantee_subject);
    },
    async upsert(grant) {
      await db()
        .insertInto('resource_access_grants')
        .values({
          resource_kind: grant.resourceKind,
          resource_id: grant.resourceId,
          owner_subject: grant.ownerSubject,
          grantee_subject: grant.granteeSubject,
          role: grant.role,
          expires_at: grant.expiresAt,
        })
        .onConflict((oc) =>
          oc
            .columns(['resource_kind', 'resource_id', 'grantee_subject'])
            .doUpdateSet({ role: grant.role, expires_at: grant.expiresAt })
        )
        .execute();
    },
    async listForOwner(ownerSubject, kind, resourceId) {
      const rows = await db()
        .selectFrom('resource_access_grants as g')
        .leftJoin('identities as i', (join) => join.onRef('i.subject', '=', 'g.grantee_subject'))
        .selectAll('g')
        .select(['i.display_name', 'i.email'])
        .where('g.resource_kind', '=', kind)
        .where('g.resource_id', '=', resourceId)
        .where('g.owner_subject', '=', ownerSubject)
        .orderBy('g.created_at', 'desc')
        .orderBy('g.id')
        .execute();
      return rows.map((row) => ({
        ...grantFromRow(row),
        granteeName: row.display_name,
        granteeEmail: row.email,
      }));
    },
    async revoke(ownerSubject, kind, resourceId, grantId) {
      const deleted = await db()
        .deleteFrom('resource_access_grants')
        .where('resource_kind', '=', kind)
        .where('resource_id', '=', resourceId)
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', grantId)
        .returning('grantee_subject')
        .executeTakeFirst();
      return deleted?.grantee_subject ?? null;
    },
    async removeGrantee(kind, resourceId, granteeSubject) {
      const result = await db()
        .deleteFrom('resource_access_grants')
        .where('resource_kind', '=', kind)
        .where('resource_id', '=', resourceId)
        .where('grantee_subject', '=', granteeSubject)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async deleteForResource(kind, resourceId) {
      const result = await db()
        .deleteFrom('resource_access_grants')
        .where('resource_kind', '=', kind)
        .where('resource_id', '=', resourceId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async countActive(kind, resourceIds) {
      if (resourceIds.length === 0) return [];
      const rows = await db()
        .selectFrom('resource_access_grants')
        .select((eb) => ['resource_id', eb.fn.count<string>('id').as('count')])
        .where('resource_kind', '=', kind)
        .where('resource_id', 'in', resourceIds)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
        .groupBy('resource_id')
        .orderBy('resource_id')
        .execute();
      return rows.map((row) => ({ resourceId: row.resource_id, count: Number(row.count) }));
    },
  };
}

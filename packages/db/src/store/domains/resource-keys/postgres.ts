import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { ResourceKeyStore } from './types';

export function postgresResourceKeys(db: () => Kysely<DB>): ResourceKeyStore {
  return {
    async find(kind, resourceId) {
      const row = await db()
        .selectFrom('resource_keys')
        .select('id')
        .where('resource_kind', '=', kind)
        .where('resource_id', '=', resourceId)
        .executeTakeFirst();
      return row?.id ?? null;
    },
    async findMany(kind, resourceIds) {
      if (resourceIds.length === 0) return [];
      const rows = await db()
        .selectFrom('resource_keys')
        .select(['id', 'resource_id'])
        .where('resource_kind', '=', kind)
        .where('resource_id', 'in', resourceIds)
        .orderBy('resource_id')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({ id: row.id, resourceId: row.resource_id }));
    },
    async insertIfAbsent(kind, resourceId) {
      const inserted = await db()
        .insertInto('resource_keys')
        .values({ resource_kind: kind, resource_id: resourceId })
        .onConflict((oc) => oc.columns(['resource_kind', 'resource_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted?.id ?? null;
    },
    async delete(kind, resourceId) {
      const result = await db()
        .deleteFrom('resource_keys')
        .where('resource_kind', '=', kind)
        .where('resource_id', '=', resourceId)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    async wrappings(keyIds) {
      if (keyIds.length === 0) return [];
      const rows = await db()
        .selectFrom('resource_key_grants')
        .select(['resource_key_id', 'holder_kind', 'holder', 'wrapped_key'])
        .where('resource_key_id', 'in', keyIds)
        .orderBy('resource_key_id')
        .orderBy('holder_kind')
        .orderBy('holder')
        .execute();
      return rows.map((row) => ({
        resourceKeyId: row.resource_key_id,
        holderKind: row.holder_kind,
        holder: row.holder,
        wrappedKey: row.wrapped_key,
      }));
    },
    async holdsWrapping(keyId, holder, holderKinds) {
      if (holderKinds.length === 0) return false;
      const row = await db()
        .selectFrom('resource_key_grants')
        .select('holder_kind')
        .where('resource_key_id', '=', keyId)
        .where('holder', '=', holder)
        .where('holder_kind', 'in', holderKinds)
        .executeTakeFirst();
      return row !== undefined;
    },
    async upsertWrapping(wrapping) {
      await db()
        .insertInto('resource_key_grants')
        .values({
          resource_key_id: wrapping.resourceKeyId,
          holder_kind: wrapping.holderKind,
          holder: wrapping.holder,
          wrapped_key: wrapping.wrappedKey,
          kek_version: wrapping.kekVersion,
          granted_by: wrapping.grantedBy,
        })
        .onConflict((oc) =>
          oc.columns(['resource_key_id', 'holder_kind', 'holder']).doUpdateSet({
            wrapped_key: wrapping.wrappedKey,
            kek_version: wrapping.kekVersion,
            granted_by: wrapping.grantedBy,
          })
        )
        .execute();
    },
    async insertWrappingIfAbsent(wrapping) {
      const inserted = await db()
        .insertInto('resource_key_grants')
        .values({
          resource_key_id: wrapping.resourceKeyId,
          holder_kind: wrapping.holderKind,
          holder: wrapping.holder,
          wrapped_key: wrapping.wrappedKey,
          kek_version: wrapping.kekVersion,
          granted_by: wrapping.grantedBy,
        })
        .onConflict((oc) => oc.columns(['resource_key_id', 'holder_kind', 'holder']).doNothing())
        .returning('holder')
        .executeTakeFirst();
      return inserted !== undefined;
    },
    async deleteWrappings(keyId, holder, holderKinds) {
      if (holderKinds.length === 0) return 0;
      const result = await db()
        .deleteFrom('resource_key_grants')
        .where('resource_key_id', '=', keyId)
        .where('holder', '=', holder)
        .where('holder_kind', 'in', holderKinds)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    async holders(keyId) {
      const rows = await db()
        .selectFrom('resource_key_grants')
        .select(['holder_kind', 'holder', 'granted_by', 'kek_version'])
        .where('resource_key_id', '=', keyId)
        .orderBy('created_at', 'asc')
        .orderBy('holder_kind')
        .orderBy('holder')
        .execute();
      return rows.map((row) => ({
        holderKind: row.holder_kind,
        holder: row.holder,
        grantedBy: row.granted_by,
        kekVersion: row.kek_version,
      }));
    },
    async findWithWrapping(kind, resourceId, holderKind, holder) {
      const row = await db()
        .selectFrom('resource_keys as k')
        .leftJoin('resource_key_grants as g', (join) =>
          join
            .onRef('g.resource_key_id', '=', 'k.id')
            .on('g.holder_kind', '=', holderKind)
            .on('g.holder', '=', holder)
        )
        .select(['k.id', 'g.wrapped_key'])
        .where('k.resource_kind', '=', kind)
        .where('k.resource_id', '=', resourceId)
        .executeTakeFirst();
      return row ? { id: row.id, wrappedKey: row.wrapped_key ?? null } : null;
    },
    async pruneOrphans() {
      const result = await sql<{ id: string }>`
        DELETE FROM resource_keys k
         WHERE (k.resource_kind = 'chat' AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = k.resource_id))
            OR (k.resource_kind = 'chat_project' AND NOT EXISTS (SELECT 1 FROM chat_projects p WHERE p.id = k.resource_id))
            OR (k.resource_kind = 'prompt_library' AND NOT EXISTS (SELECT 1 FROM prompt_libraries l WHERE l.id = k.resource_id))
            OR (k.resource_kind = 'artifact' AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.id = k.resource_id))
        RETURNING k.id
      `.execute(db());
      return result.rows.length;
    },
  };
}

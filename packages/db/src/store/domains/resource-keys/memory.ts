import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { ResourceKeyStore, ResourceKeyWrappingInput } from './types';

/** Which table holds each kind of resource a key may belong to. */
const RESOURCE_TABLES = {
  chat: 'chats',
  chat_project: 'chat_projects',
  prompt_library: 'prompt_libraries',
  artifact: 'artifacts',
} as const;

export function memoryResourceKeys(tables: MemoryTables): ResourceKeyStore {
  const grantValues = (wrapping: ResourceKeyWrappingInput) => ({
    resource_key_id: wrapping.resourceKeyId,
    holder_kind: wrapping.holderKind,
    holder: wrapping.holder,
    wrapped_key: wrapping.wrappedKey,
    kek_version: wrapping.kekVersion,
    granted_by: wrapping.grantedBy,
  });

  return {
    async find(kind, resourceId) {
      const id = resourceId;
      const row = tables.first(
        'resource_keys',
        (r) => r.resource_kind === kind && r.resource_id === id
      );
      return row?.id ?? null;
    },
    async findMany(kind, resourceIds) {
      if (resourceIds.length === 0) return [];
      const wanted = new Set(resourceIds);
      const rows = tables.select(
        'resource_keys',
        (r) => r.resource_kind === kind && wanted.has(r.resource_id)
      );
      return orderBy(rows, [(r) => r.resource_id], [(r) => r.id]).map((row) => ({
        id: row.id,
        resourceId: row.resource_id,
      }));
    },
    async insertIfAbsent(kind, resourceId) {
      const row = tables.upsert(
        'resource_keys',
        {
          id: globalThis.crypto.randomUUID(),
          resource_kind: kind,
          resource_id: resourceId,
          created_at: new Date(),
        },
        ['resource_kind', 'resource_id']
      );
      return row?.id ?? null;
    },
    async delete(kind, resourceId) {
      const id = resourceId;
      const deleted = tables.delete(
        'resource_keys',
        (r) => r.resource_kind === kind && r.resource_id === id
      );
      const keys = new Set(deleted.map((r) => r.id));
      tables.delete('resource_key_grants', (r) => keys.has(r.resource_key_id));
      return deleted.length;
    },
    async wrappings(keyIds) {
      if (keyIds.length === 0) return [];
      const wanted = new Set(keyIds);
      const rows = tables.select('resource_key_grants', (r) => wanted.has(r.resource_key_id));
      return orderBy(
        rows,
        [(r) => r.resource_key_id],
        [(r) => r.holder_kind],
        [(r) => r.holder]
      ).map((row) => ({
        resourceKeyId: row.resource_key_id,
        holderKind: row.holder_kind,
        holder: row.holder,
        wrappedKey: row.wrapped_key,
      }));
    },
    async holdsWrapping(keyId, holder, holderKinds) {
      if (holderKinds.length === 0) return false;
      const id = keyId;
      return (
        tables.first(
          'resource_key_grants',
          (r) =>
            r.resource_key_id === id && r.holder === holder && holderKinds.includes(r.holder_kind)
        ) !== undefined
      );
    },
    async upsertWrapping(wrapping) {
      tables.upsert(
        'resource_key_grants',
        { ...grantValues(wrapping), created_at: new Date() },
        ['resource_key_id', 'holder_kind', 'holder'],
        {
          wrapped_key: wrapping.wrappedKey,
          kek_version: wrapping.kekVersion,
          granted_by: wrapping.grantedBy,
        }
      );
    },
    async insertWrappingIfAbsent(wrapping) {
      return (
        tables.upsert('resource_key_grants', { ...grantValues(wrapping), created_at: new Date() }, [
          'resource_key_id',
          'holder_kind',
          'holder',
        ]) !== undefined
      );
    },
    async deleteWrappings(keyId, holder, holderKinds) {
      if (holderKinds.length === 0) return 0;
      const id = keyId;
      return tables.delete(
        'resource_key_grants',
        (r) =>
          r.resource_key_id === id && r.holder === holder && holderKinds.includes(r.holder_kind)
      ).length;
    },
    async holders(keyId) {
      const id = keyId;
      const rows = tables.select('resource_key_grants', (r) => r.resource_key_id === id);
      return orderBy(rows, [(r) => r.created_at], [(r) => r.holder_kind], [(r) => r.holder]).map(
        (row) => ({
          holderKind: row.holder_kind,
          holder: row.holder,
          grantedBy: row.granted_by,
          kekVersion: row.kek_version,
        })
      );
    },
    async findWithWrapping(kind, resourceId, holderKind, holder) {
      const id = resourceId;
      const key = tables.first(
        'resource_keys',
        (r) => r.resource_kind === kind && r.resource_id === id
      );
      if (!key) return null;
      const grant = tables.first(
        'resource_key_grants',
        (r) => r.resource_key_id === key.id && r.holder_kind === holderKind && r.holder === holder
      );
      return { id: key.id, wrappedKey: grant?.wrapped_key ?? null };
    },
    async pruneOrphans() {
      const exists = (kind: keyof typeof RESOURCE_TABLES, resourceId: string) =>
        tables.selectWhere(RESOURCE_TABLES[kind], (row) => row.id === resourceId).length > 0;
      const pruned = tables.delete('resource_keys', (r) => {
        const kind = r.resource_kind;
        if (
          kind !== 'chat' &&
          kind !== 'chat_project' &&
          kind !== 'prompt_library' &&
          kind !== 'artifact'
        ) {
          return false;
        }
        return !exists(kind, r.resource_id);
      });
      const keys = new Set(pruned.map((r) => r.id));
      tables.delete('resource_key_grants', (r) => keys.has(r.resource_key_id));
      return pruned.length;
    },
  };
}

import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { instanceValues, mirthConnectionFromRow, mirthInstanceFromRow } from './record';
import type { MirthInstanceStore } from './types';

export function postgresMirthInstances(db: () => Kysely<DB>): MirthInstanceStore {
  return {
    async listWithConnection(subject) {
      const rows = await db()
        .selectFrom('mirth_instances')
        .leftJoin('mirth_instance_connections', (join) =>
          join
            .onRef('mirth_instance_connections.instance_id', '=', 'mirth_instances.id')
            .on('mirth_instance_connections.subject', '=', subject)
        )
        .selectAll('mirth_instances')
        .select([
          'mirth_instance_connections.username',
          'mirth_instance_connections.permissions',
          'mirth_instance_connections.encrypted_credentials',
        ])
        .where('mirth_instances.enabled', '=', true)
        .orderBy('mirth_instances.name')
        .execute();
      return rows.map((row) => ({
        instance: mirthInstanceFromRow(row),
        connection:
          row.username === null || row.permissions === null || row.encrypted_credentials === null
            ? null
            : mirthConnectionFromRow({
                username: row.username,
                permissions: row.permissions,
                encrypted_credentials: row.encrypted_credentials,
              }),
      }));
    },
    async getConnection(instanceId, subject) {
      const row = await db()
        .selectFrom('mirth_instance_connections')
        .select(['username', 'permissions', 'encrypted_credentials'])
        .where('instance_id', '=', instanceId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row ? mirthConnectionFromRow(row) : null;
    },
    async upsertConnection(instanceId, subject, connection) {
      await db()
        .insertInto('mirth_instance_connections')
        .values({
          instance_id: instanceId,
          subject,
          encrypted_credentials: connection.encryptedCredentials,
          username: connection.username,
          permissions: [...connection.permissions],
        })
        .onConflict((oc) =>
          oc.constraint('mirth_instance_connections_pk').doUpdateSet({
            encrypted_credentials: connection.encryptedCredentials,
            username: connection.username,
            permissions: [...connection.permissions],
            updated_at: new Date(),
          })
        )
        .execute();
    },
    async updateConnectionPermissions(instanceId, subject, permissions) {
      const result = await db()
        .updateTable('mirth_instance_connections')
        .set({ permissions: [...permissions], updated_at: new Date() })
        .where('instance_id', '=', instanceId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async deleteConnection(instanceId, subject) {
      const result = await db()
        .deleteFrom('mirth_instance_connections')
        .where('instance_id', '=', instanceId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async connectionPermissions(subject) {
      const rows = await db()
        .selectFrom('mirth_instance_connections')
        .innerJoin(
          'mirth_instances',
          'mirth_instances.id',
          'mirth_instance_connections.instance_id'
        )
        .select(['mirth_instance_connections.permissions'])
        .where('mirth_instance_connections.subject', '=', subject)
        .where('mirth_instances.enabled', '=', true)
        .orderBy('mirth_instance_connections.instance_id')
        .execute();
      return rows.map((row) => row.permissions);
    },
    async list() {
      const rows = await db().selectFrom('mirth_instances').selectAll().orderBy('name').execute();
      return rows.map(mirthInstanceFromRow);
    },
    async get(id) {
      const row = await db()
        .selectFrom('mirth_instances')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? mirthInstanceFromRow(row) : null;
    },
    async create(instance) {
      const row = await db()
        .insertInto('mirth_instances')
        .values({
          ...instanceValues(instance),
          ca_pem: instance.caPem ?? null,
          settings: JSON.stringify({}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async update(id, instance) {
      const result = await db()
        .updateTable('mirth_instances')
        .set({ ...instanceValues(instance), updated_at: new Date().toISOString() })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async delete(id) {
      const result = await db()
        .deleteFrom('mirth_instances')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}

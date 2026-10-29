import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { instanceValues, adManagerConnectionFromRow, adManagerInstanceFromRow } from './record';
import type { AdManagerInstanceStore } from './types';

export function postgresAdmanagerInstances(db: () => Kysely<DB>): AdManagerInstanceStore {
  return {
    async listWithConnection(subject) {
      const rows = await db()
        .selectFrom('admanager_instances')
        .leftJoin('admanager_instance_connections', (join) =>
          join
            .onRef('admanager_instance_connections.instance_id', '=', 'admanager_instances.id')
            .on('admanager_instance_connections.subject', '=', subject)
        )
        .selectAll('admanager_instances')
        .select([
          'admanager_instance_connections.technician_name',
          'admanager_instance_connections.permissions',
          'admanager_instance_connections.encrypted_credentials',
        ])
        .where('admanager_instances.enabled', '=', true)
        .orderBy('admanager_instances.name')
        .execute();
      return rows.map((row) => ({
        instance: adManagerInstanceFromRow(row),
        connection:
          row.technician_name === null ||
          row.permissions === null ||
          row.encrypted_credentials === null
            ? null
            : adManagerConnectionFromRow({
                technician_name: row.technician_name,
                permissions: row.permissions,
                encrypted_credentials: row.encrypted_credentials,
              }),
      }));
    },
    async getConnection(instanceId, subject) {
      const row = await db()
        .selectFrom('admanager_instance_connections')
        .select(['technician_name', 'permissions', 'encrypted_credentials'])
        .where('instance_id', '=', instanceId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row ? adManagerConnectionFromRow(row) : null;
    },
    async upsertConnection(instanceId, subject, connection) {
      await db()
        .insertInto('admanager_instance_connections')
        .values({
          instance_id: instanceId,
          subject,
          encrypted_credentials: connection.encryptedCredentials,
          technician_name: connection.technicianName,
          permissions: [...connection.permissions],
        })
        .onConflict((oc) =>
          oc.constraint('admanager_instance_connections_pk').doUpdateSet({
            encrypted_credentials: connection.encryptedCredentials,
            technician_name: connection.technicianName,
            permissions: [...connection.permissions],
            updated_at: new Date(),
          })
        )
        .execute();
    },
    async updateConnectionPermissions(instanceId, subject, permissions) {
      const result = await db()
        .updateTable('admanager_instance_connections')
        .set({ permissions: [...permissions], updated_at: new Date() })
        .where('instance_id', '=', instanceId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async deleteConnection(instanceId, subject) {
      const result = await db()
        .deleteFrom('admanager_instance_connections')
        .where('instance_id', '=', instanceId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async connectionPermissions(subject) {
      const rows = await db()
        .selectFrom('admanager_instance_connections')
        .innerJoin(
          'admanager_instances',
          'admanager_instances.id',
          'admanager_instance_connections.instance_id'
        )
        .select(['admanager_instance_connections.permissions'])
        .where('admanager_instance_connections.subject', '=', subject)
        .where('admanager_instances.enabled', '=', true)
        .orderBy('admanager_instance_connections.instance_id')
        .execute();
      return rows.map((row) => row.permissions);
    },
    async list() {
      const rows = await db()
        .selectFrom('admanager_instances')
        .selectAll()
        .orderBy('name')
        .execute();
      return rows.map(adManagerInstanceFromRow);
    },
    async get(id) {
      const row = await db()
        .selectFrom('admanager_instances')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? adManagerInstanceFromRow(row) : null;
    },
    async create(instance) {
      const row = await db()
        .insertInto('admanager_instances')
        .values({
          ...instanceValues(instance),
          ca_pem: instance.caPem ?? null,
          settings: JSON.stringify(instance.settings.values),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async update(id, instance) {
      const result = await db()
        .updateTable('admanager_instances')
        .set({
          ...instanceValues(instance),
          updated_at: new Date().toISOString(),
          // jsonb - text[] drops the keys this form owns, then || lays the
          // new values over what remains.
          settings: sql`(settings - ARRAY[${sql.join(
            instance.settings.ownedKeys.map((key) => sql.lit(key))
          )}]::text[]) || ${JSON.stringify(instance.settings.values)}::jsonb`,
        })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async delete(id) {
      const result = await db()
        .deleteFrom('admanager_instances')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}

import { orderBy } from '../../memory/order';
import { toJson, uniqueViolation, type MemoryTables } from '../../memory/tables';
import {
  instanceValues,
  mergedSettings,
  adManagerConnectionFromRow,
  adManagerInstanceFromRow,
} from './record';
import type { AdManagerInstanceStore } from './types';

export function memoryAdmanagerInstances(tables: MemoryTables): AdManagerInstanceStore {
  // The connector's store turns a taken name into its own answer (23505).
  const refuseTakenName = (name: string, except?: string) => {
    if (tables.first('admanager_instances', (r) => r.name === name && r.id !== except)) {
      throw uniqueViolation('admanager_instances', 'idx_admanager_instances_name');
    }
  };
  const connectionOf = (id: string, subject: string) => {
    const wanted = id;
    return (r: { instance_id: string; subject: string }) =>
      r.instance_id === wanted && r.subject === subject;
  };
  return {
    async listWithConnection(subject) {
      return orderBy(
        tables.select('admanager_instances', (r) => r.enabled),
        [(r) => r.name]
      ).map((instance) => {
        const connection = tables.first(
          'admanager_instance_connections',
          (c) => c.instance_id === instance.id && c.subject === subject
        );
        return {
          instance: adManagerInstanceFromRow(instance),
          connection: connection ? adManagerConnectionFromRow(connection) : null,
        };
      });
    },
    async getConnection(id, subject) {
      const row = tables.first('admanager_instance_connections', connectionOf(id, subject));
      return row ? adManagerConnectionFromRow(row) : null;
    },
    async upsertConnection(id, subject, connection) {
      const now = new Date();
      tables.upsert(
        'admanager_instance_connections',
        {
          instance_id: id,
          subject,
          encrypted_credentials: connection.encryptedCredentials,
          technician_name: connection.technicianName,
          permissions: [...connection.permissions],
          created_at: now,
          updated_at: now,
        },
        ['instance_id', 'subject'],
        {
          encrypted_credentials: connection.encryptedCredentials,
          technician_name: connection.technicianName,
          permissions: [...connection.permissions],
          updated_at: new Date(),
        }
      );
    },
    async updateConnectionPermissions(id, subject, permissions) {
      return tables.update('admanager_instance_connections', connectionOf(id, subject), {
        permissions: [...permissions],
        updated_at: new Date(),
      }).length;
    },
    async deleteConnection(id, subject) {
      return tables.delete('admanager_instance_connections', connectionOf(id, subject)).length;
    },
    async connectionPermissions(subject) {
      const enabled = new Set(
        tables.select('admanager_instances', (r) => r.enabled).map((r) => r.id)
      );
      return orderBy(
        tables.select(
          'admanager_instance_connections',
          (r) => r.subject === subject && enabled.has(r.instance_id)
        ),
        [(r) => r.instance_id]
      ).map((row) => row.permissions);
    },
    async list() {
      return orderBy(tables.select('admanager_instances'), [(r) => r.name]).map(
        adManagerInstanceFromRow
      );
    },
    async get(id) {
      const wanted = id;
      const row = tables.first('admanager_instances', (r) => r.id === wanted);
      return row ? adManagerInstanceFromRow(row) : null;
    },
    async create(instance) {
      refuseTakenName(instance.name);
      const now = new Date();
      return tables.insert('admanager_instances', {
        ...instanceValues(instance),
        id: globalThis.crypto.randomUUID(),
        ca_pem: instance.caPem ?? null,
        settings: toJson(instance.settings.values),
        created_at: now,
        updated_at: now,
      }).id;
    },
    async update(id, instance) {
      const wanted = id;
      if (tables.first('admanager_instances', (r) => r.id === wanted)) {
        refuseTakenName(instance.name, wanted);
      }
      return tables.update(
        'admanager_instances',
        (r) => r.id === wanted,
        (row) => ({
          ...instanceValues(instance),
          updated_at: new Date(),
          settings: toJson(mergedSettings(row.settings, instance.settings)),
        })
      ).length;
    },
    async delete(id) {
      const wanted = id;
      tables.delete('admanager_instance_connections', (r) => r.instance_id === wanted);
      return tables.delete('admanager_instances', (r) => r.id === wanted).length;
    },
  };
}

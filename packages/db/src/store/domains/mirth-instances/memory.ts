import { orderBy } from '../../memory/order';
import { toJson, uniqueViolation, type MemoryTables } from '../../memory/tables';
import { instanceValues, mirthConnectionFromRow, mirthInstanceFromRow } from './record';
import type { MirthInstanceStore } from './types';

export function memoryMirthInstances(tables: MemoryTables): MirthInstanceStore {
  // The connector's store turns a taken name into its own answer (23505).
  const refuseTakenName = (name: string, except?: string) => {
    if (tables.first('mirth_instances', (r) => r.name === name && r.id !== except)) {
      throw uniqueViolation('mirth_instances', 'idx_mirth_instances_name');
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
        tables.select('mirth_instances', (r) => r.enabled),
        [(r) => r.name]
      ).map((instance) => {
        const connection = tables.first(
          'mirth_instance_connections',
          (c) => c.instance_id === instance.id && c.subject === subject
        );
        return {
          instance: mirthInstanceFromRow(instance),
          connection: connection ? mirthConnectionFromRow(connection) : null,
        };
      });
    },
    async getConnection(id, subject) {
      const row = tables.first('mirth_instance_connections', connectionOf(id, subject));
      return row ? mirthConnectionFromRow(row) : null;
    },
    async upsertConnection(id, subject, connection) {
      tables.upsert(
        'mirth_instance_connections',
        {
          instance_id: id,
          subject,
          encrypted_credentials: connection.encryptedCredentials,
          username: connection.username,
          permissions: [...connection.permissions],
          created_at: new Date(),
          updated_at: new Date(),
        },
        ['instance_id', 'subject'],
        {
          encrypted_credentials: connection.encryptedCredentials,
          username: connection.username,
          permissions: [...connection.permissions],
          updated_at: new Date(),
        }
      );
    },
    async updateConnectionPermissions(id, subject, permissions) {
      return tables.update('mirth_instance_connections', connectionOf(id, subject), {
        permissions: [...permissions],
        updated_at: new Date(),
      }).length;
    },
    async deleteConnection(id, subject) {
      return tables.delete('mirth_instance_connections', connectionOf(id, subject)).length;
    },
    async connectionPermissions(subject) {
      const enabled = new Set(tables.select('mirth_instances', (r) => r.enabled).map((r) => r.id));
      return orderBy(
        tables.select(
          'mirth_instance_connections',
          (r) => r.subject === subject && enabled.has(r.instance_id)
        ),
        [(r) => r.instance_id]
      ).map((row) => row.permissions);
    },
    async list() {
      return orderBy(tables.select('mirth_instances'), [(r) => r.name]).map(mirthInstanceFromRow);
    },
    async get(id) {
      const wanted = id;
      const row = tables.first('mirth_instances', (r) => r.id === wanted);
      return row ? mirthInstanceFromRow(row) : null;
    },
    async create(instance) {
      refuseTakenName(instance.name);
      const now = new Date();
      return tables.insert('mirth_instances', {
        ...instanceValues(instance),
        id: globalThis.crypto.randomUUID(),
        ca_pem: instance.caPem ?? null,
        settings: toJson({}),
        created_at: now,
        updated_at: now,
      }).id;
    },
    async update(id, instance) {
      const wanted = id;
      if (tables.first('mirth_instances', (r) => r.id === wanted)) {
        refuseTakenName(instance.name, wanted);
      }
      return tables.update('mirth_instances', (r) => r.id === wanted, {
        ...instanceValues(instance),
        updated_at: new Date(),
      }).length;
    },
    async delete(id) {
      const wanted = id;
      tables.delete('mirth_instance_connections', (r) => r.instance_id === wanted);
      return tables.delete('mirth_instances', (r) => r.id === wanted).length;
    },
  };
}

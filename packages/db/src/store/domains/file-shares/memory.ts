import { orderBy } from '../../memory/order';
import { toJson, uniqueViolation, type MemoryTables } from '../../memory/tables';
import { connectionFromRow, fileShareFromRow, shareValues } from './record';
import type { FileShareStore } from './types';

export function memoryFileShares(tables: MemoryTables): FileShareStore {
  // The connector's store turns a taken name into its own answer (23505).
  const refuseTakenName = (name: string, except?: string) => {
    if (tables.first('file_shares', (r) => r.name === name && r.id !== except)) {
      throw uniqueViolation('file_shares', 'idx_file_shares_name');
    }
  };
  const connectionOf = (id: string, subject: string) => {
    const wanted = id;
    return (r: { share_id: string; subject: string }) =>
      r.share_id === wanted && r.subject === subject;
  };
  return {
    async listWithConnection(subject) {
      const shares = orderBy(
        tables.select('file_shares', (r) => r.enabled),
        [(r) => r.name]
      );
      return shares.map((share) => {
        const connection = tables.first(
          'file_share_connections',
          (c) => c.share_id === share.id && c.subject === subject
        );
        return {
          share: fileShareFromRow(share),
          connection: connection ? connectionFromRow(connection) : null,
        };
      });
    },
    async getConnection(id, subject) {
      const row = tables.first('file_share_connections', connectionOf(id, subject));
      return row ? connectionFromRow(row) : null;
    },
    async upsertConnection(id, subject, connection) {
      tables.upsert(
        'file_share_connections',
        {
          share_id: id,
          subject,
          encrypted_credentials: connection.encryptedCredentials,
          username: connection.username,
          tool_access: connection.toolAccess,
          allow_delete: connection.allowDelete,
          created_at: new Date(),
          updated_at: new Date(),
        },
        ['share_id', 'subject'],
        {
          encrypted_credentials: connection.encryptedCredentials,
          username: connection.username,
          tool_access: connection.toolAccess,
          allow_delete: connection.allowDelete,
          updated_at: new Date(),
        }
      );
    },
    async updateConnectionExposure(id, subject, { toolAccess, allowDelete }) {
      return tables.update('file_share_connections', connectionOf(id, subject), {
        tool_access: toolAccess,
        allow_delete: allowDelete,
        updated_at: new Date(),
      }).length;
    },
    async deleteConnection(id, subject) {
      return tables.delete('file_share_connections', connectionOf(id, subject)).length;
    },
    async connectionExposures(subject) {
      const enabled = new Set(tables.select('file_shares', (r) => r.enabled).map((r) => r.id));
      return orderBy(
        tables.select(
          'file_share_connections',
          (r) => r.subject === subject && enabled.has(r.share_id)
        ),
        [(r) => r.share_id]
      ).map((row) => ({ toolAccess: row.tool_access, allowDelete: row.allow_delete }));
    },
    async list() {
      return orderBy(tables.select('file_shares'), [(r) => r.name]).map(fileShareFromRow);
    },
    async get(id) {
      const wanted = id;
      const row = tables.first('file_shares', (r) => r.id === wanted);
      return row ? fileShareFromRow(row) : null;
    },
    async create(share) {
      refuseTakenName(share.name);
      const now = new Date();
      return tables.insert('file_shares', {
        ...shareValues(share),
        id: globalThis.crypto.randomUUID(),
        settings: toJson({}),
        created_at: now,
        updated_at: now,
      }).id;
    },
    async update(id, share) {
      const wanted = id;
      if (tables.first('file_shares', (r) => r.id === wanted)) refuseTakenName(share.name, wanted);
      return tables.update('file_shares', (r) => r.id === wanted, {
        ...shareValues(share),
        updated_at: new Date(),
      }).length;
    },
    async recordHostKeyFingerprint(id, fingerprint) {
      const wanted = id;
      return tables.update(
        'file_shares',
        (r) => r.id === wanted && r.host_key_fingerprint === null,
        { host_key_fingerprint: fingerprint, updated_at: new Date() }
      ).length;
    },
    async delete(id) {
      const wanted = id;
      tables.delete('file_share_connections', (r) => r.share_id === wanted);
      tables.delete('batch_processed_files', (r) => r.share_id === wanted);
      return tables.delete('file_shares', (r) => r.id === wanted).length;
    },
  };
}

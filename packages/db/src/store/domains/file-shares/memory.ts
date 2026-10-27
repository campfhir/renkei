import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { connectionFromRow, fileShareFromRow, shareValues } from './record';
import type { FileShareStore } from './types';

export function memoryFileShares(tables: MemoryTables): FileShareStore {
  const shareId = (id: string) => tables.param('file_shares', 'id', id);
  const connectionOf = (id: string, subject: string) => {
    const wanted = tables.param('file_share_connections', 'share_id', id);
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
      const wanted = shareId(id);
      const row = tables.first('file_shares', (r) => r.id === wanted);
      return row ? fileShareFromRow(row) : null;
    },
    async create(share) {
      return tables.insert('file_shares', { ...shareValues(share), settings: JSON.stringify({}) })
        .id;
    },
    async update(id, share) {
      const wanted = shareId(id);
      return tables.update('file_shares', (r) => r.id === wanted, {
        ...shareValues(share),
        updated_at: new Date(),
      }).length;
    },
    async recordHostKeyFingerprint(id, fingerprint) {
      const wanted = shareId(id);
      return tables.update(
        'file_shares',
        (r) => r.id === wanted && r.host_key_fingerprint === null,
        { host_key_fingerprint: fingerprint, updated_at: new Date() }
      ).length;
    },
    async delete(id) {
      const wanted = shareId(id);
      return tables.delete('file_shares', (r) => r.id === wanted).length;
    },
  };
}

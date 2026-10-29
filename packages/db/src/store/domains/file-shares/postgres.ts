import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { connectionFromRow, fileShareFromRow, shareValues } from './record';
import type { FileShareStore } from './types';

export function postgresFileShares(db: () => Kysely<DB>): FileShareStore {
  return {
    async listWithConnection(subject) {
      const rows = await db()
        .selectFrom('file_shares')
        .leftJoin('file_share_connections', (join) =>
          join
            .onRef('file_share_connections.share_id', '=', 'file_shares.id')
            .on('file_share_connections.subject', '=', subject)
        )
        .selectAll('file_shares')
        .select([
          'file_share_connections.username',
          'file_share_connections.tool_access',
          'file_share_connections.allow_delete',
          'file_share_connections.encrypted_credentials',
        ])
        .where('file_shares.enabled', '=', true)
        .orderBy('file_shares.name')
        .execute();
      return rows.map((row) => ({
        share: fileShareFromRow(row),
        connection:
          row.username === null || row.tool_access === null || row.encrypted_credentials === null
            ? null
            : connectionFromRow({
                username: row.username,
                tool_access: row.tool_access,
                allow_delete: row.allow_delete === true,
                encrypted_credentials: row.encrypted_credentials,
              }),
      }));
    },
    async getConnection(shareId, subject) {
      const row = await db()
        .selectFrom('file_share_connections')
        .select(['username', 'tool_access', 'allow_delete', 'encrypted_credentials'])
        .where('share_id', '=', shareId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row ? connectionFromRow(row) : null;
    },
    async upsertConnection(shareId, subject, connection) {
      await db()
        .insertInto('file_share_connections')
        .values({
          share_id: shareId,
          subject,
          encrypted_credentials: connection.encryptedCredentials,
          username: connection.username,
          tool_access: connection.toolAccess,
          allow_delete: connection.allowDelete,
        })
        .onConflict((oc) =>
          oc.constraint('file_share_connections_pk').doUpdateSet({
            encrypted_credentials: connection.encryptedCredentials,
            username: connection.username,
            tool_access: connection.toolAccess,
            allow_delete: connection.allowDelete,
            updated_at: new Date(),
          })
        )
        .execute();
    },
    async updateConnectionExposure(shareId, subject, { toolAccess, allowDelete }) {
      const result = await db()
        .updateTable('file_share_connections')
        .set({ tool_access: toolAccess, allow_delete: allowDelete, updated_at: new Date() })
        .where('share_id', '=', shareId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async deleteConnection(shareId, subject) {
      const result = await db()
        .deleteFrom('file_share_connections')
        .where('share_id', '=', shareId)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async connectionExposures(subject) {
      const rows = await db()
        .selectFrom('file_share_connections')
        .innerJoin('file_shares', 'file_shares.id', 'file_share_connections.share_id')
        .select(['file_share_connections.tool_access', 'file_share_connections.allow_delete'])
        .where('file_share_connections.subject', '=', subject)
        .where('file_shares.enabled', '=', true)
        .orderBy('file_share_connections.share_id')
        .execute();
      return rows.map((row) => ({ toolAccess: row.tool_access, allowDelete: row.allow_delete }));
    },
    async list() {
      const rows = await db().selectFrom('file_shares').selectAll().orderBy('name').execute();
      return rows.map(fileShareFromRow);
    },
    async get(id) {
      const row = await db()
        .selectFrom('file_shares')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? fileShareFromRow(row) : null;
    },
    async create(share) {
      const row = await db()
        .insertInto('file_shares')
        .values({ ...shareValues(share), settings: JSON.stringify({}) })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async update(id, share) {
      const result = await db()
        .updateTable('file_shares')
        .set({ ...shareValues(share), updated_at: new Date().toISOString() })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async recordHostKeyFingerprint(id, fingerprint) {
      const result = await db()
        .updateTable('file_shares')
        .set({ host_key_fingerprint: fingerprint, updated_at: new Date().toISOString() })
        .where('id', '=', id)
        .where('host_key_fingerprint', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async delete(id) {
      const result = await db().deleteFrom('file_shares').where('id', '=', id).executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}

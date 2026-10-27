import type { MemoryTables } from '../../memory/tables';
import type { SessionStore } from './types';

export function memorySessions(tables: MemoryTables): SessionStore {
  return {
    async create({ id, subject, roles, expiresAt }) {
      tables.insert('sessions', { id, subject, roles, expires_at: expiresAt });
    },
    async find(id) {
      const key = tables.param('sessions', 'id', id);
      const row = tables.first('sessions', (r) => r.id === key);
      if (!row) return null;
      return {
        id: row.id,
        subject: row.subject,
        roles: row.roles,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
      };
    },
    async touch(id, at) {
      const key = tables.param('sessions', 'id', id);
      tables.update('sessions', (r) => r.id === key, { last_used_at: at });
    },
    async delete(id) {
      const key = tables.param('sessions', 'id', id);
      tables.delete('sessions', (r) => r.id === key);
    },
  };
}

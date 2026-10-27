import { groupBy, orderBy } from '../../memory/order';
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
    async lastUsedBySubject() {
      const groups = groupBy(tables.select('sessions'), (r) => r.subject);
      const rows = [...groups].map(([subject, sessions]) => ({
        subject,
        lastUsedAt: new Date(Math.max(...sessions.map((s) => s.last_used_at.getTime()))),
      }));
      return orderBy(rows, [(r) => r.subject]);
    },
    async lastUsedOf(subject) {
      const times = tables
        .select('sessions', (r) => r.subject === subject)
        .map((r) => r.last_used_at.getTime());
      return times.length === 0 ? null : new Date(Math.max(...times));
    },
    async latestRolesOf(subject) {
      const [row] = orderBy(
        tables.select('sessions', (r) => r.subject === subject),
        [(r) => r.last_used_at, 'desc'],
        [(r) => r.id]
      );
      return row ? row.roles : null;
    },
    async deleteForSubject(subject) {
      return tables.delete('sessions', (r) => r.subject === subject).length;
    },
    async revokeAll(subject) {
      return {
        sessions: tables.delete('sessions', (r) => r.subject === subject).length,
        accessTokens: tables.delete('oauth_access_tokens', (r) => r.subject === subject).length,
        refreshTokens: tables.delete('oauth_refresh_tokens', (r) => r.subject === subject).length,
      };
    },
  };
}

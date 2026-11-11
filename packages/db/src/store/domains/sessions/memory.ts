import { groupBy, orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { SessionStore } from './types';

/** What goes with deleted sessions: their key delegations and pending consents. */
function deleteSessionRows(tables: MemoryTables, ids: Set<string>): void {
  tables.delete('key_delegations', (r) => r.session_id !== null && ids.has(r.session_id));
  tables.delete('oauth_consent_requests', (r) => ids.has(r.session_id));
  tables.delete(
    'device_key_requests',
    (r) => r.asking_session_id !== null && ids.has(r.asking_session_id)
  );
}

export function memorySessions(tables: MemoryTables): SessionStore {
  const deleteSessions = (where: (r: { id: string; subject: string }) => boolean) => {
    const deleted = tables.delete('sessions', where);
    deleteSessionRows(tables, new Set(deleted.map((r) => r.id)));
    return deleted.length;
  };
  return {
    async create({ id, subject, roles, expiresAt }) {
      const now = new Date();
      tables.insert('sessions', {
        id,
        subject,
        roles,
        expires_at: expiresAt,
        created_at: now,
        last_used_at: now,
      });
    },
    async find(id) {
      const key = id;
      const row = tables.first('sessions', (r) => r.id === key);
      if (!row) return null;
      return {
        id: row.id,
        subject: row.subject,
        roles: row.roles,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      };
    },
    async touch(id, at) {
      const key = id;
      tables.update('sessions', (r) => r.id === key, { last_used_at: at });
    },
    async delete(id) {
      const key = id;
      deleteSessions((r) => r.id === key);
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
      return deleteSessions((r) => r.subject === subject);
    },
    async revokeAll(subject) {
      return {
        sessions: deleteSessions((r) => r.subject === subject),
        accessTokens: tables.delete('oauth_access_tokens', (r) => r.subject === subject).length,
        refreshTokens: tables.delete('oauth_refresh_tokens', (r) => r.subject === subject).length,
      };
    },
  };
}

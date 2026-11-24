import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { ciHealthFromRow } from './record';
import type { CiHealthStore } from './types';

export function memoryCiHealth(tables: MemoryTables): CiHealthStore {
  return {
    async listForProject(projectId) {
      return orderBy(
        tables.select('ci_health_checkins').filter((r) => r.project_id === projectId),
        [(r) => r.environment]
      ).map(ciHealthFromRow);
    },
    async issueToken(projectId, environment, token) {
      const changed = tables.update(
        'ci_health_checkins',
        (r) => r.project_id === projectId && r.environment === environment,
        {
          token_hash: token.hash,
          token_hint: token.hint,
          issued_by: token.issuedBy,
          issued_at: token.at,
        }
      );
      if (changed.length > 0) return;
      tables.insert('ci_health_checkins', {
        project_id: projectId,
        environment,
        token_hash: token.hash,
        token_hint: token.hint,
        issued_by: token.issuedBy,
        issued_at: token.at,
        status: null,
        message: null,
        version: null,
        sent_at: null,
        received_at: null,
        interval_seconds: null,
        checkins: 0,
        announced_state: null,
      });
    },
    async revoke(projectId, environment) {
      return (
        tables.delete(
          'ci_health_checkins',
          (r) => r.project_id === projectId && r.environment === environment
        ).length > 0
      );
    },
    async checkIn(tokenHash, checkin) {
      const found = tables.first('ci_health_checkins', (r) => r.token_hash === tokenHash);
      if (!found) return null;
      const [row] = tables.update('ci_health_checkins', (r) => r.token_hash === tokenHash, {
        status: checkin.status,
        message: checkin.message,
        version: checkin.version,
        sent_at: checkin.sentAt,
        received_at: checkin.receivedAt,
        interval_seconds: checkin.intervalSeconds,
        checkins: found.checkins + 1,
      });
      return row ? ciHealthFromRow(row) : null;
    },
    async listCheckedIn() {
      return orderBy(
        tables.select('ci_health_checkins').filter((r) => r.status !== null),
        [(r) => r.project_id],
        [(r) => r.environment]
      ).map(ciHealthFromRow);
    },
    async announce(projectId, environment, from, to) {
      return (
        tables.update(
          'ci_health_checkins',
          (r) =>
            r.project_id === projectId &&
            r.environment === environment &&
            (r.announced_state ?? null) === from,
          { announced_state: to }
        ).length > 0
      );
    },
  };
}

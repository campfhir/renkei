import { compareAsc } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { AdminChangeQueueStore } from './types';

export function memoryAdminChangeQueue(tables: MemoryTables): AdminChangeQueueStore {
  return {
    async operatorSubjects(role) {
      const subjects = new Set<string>();
      for (const row of tables.select('sessions', (r) => r.roles.includes(role))) {
        subjects.add(row.subject);
      }
      for (const row of tables.select('oauth_access_tokens', (r) => r.roles.includes(role))) {
        subjects.add(row.subject);
      }
      return [...subjects].sort(compareAsc);
    },
    async recordNotice(notice) {
      tables.insert('agent_notifications', {
        id: notice.id,
        subject: notice.subject,
        kind: notice.kind,
        connector: notice.connector,
        entity: notice.entity,
        headline: notice.headline,
        ref_id: notice.refId,
        ref_url: notice.refUrl,
      });
    },
    async agentName(agentId) {
      const key = tables.param('agents', 'id', agentId);
      return tables.first('agents', (r) => r.id === key)?.name ?? null;
    },
  };
}

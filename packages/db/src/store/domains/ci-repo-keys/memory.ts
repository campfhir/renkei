import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { CiRepoKeyStore } from './types';

export function memoryCiRepoKeys(tables: MemoryTables): CiRepoKeyStore {
  return {
    async set(projectId, host, repoKey) {
      const now = new Date();
      const changed = tables.update('ci_repo_keys', (r) => r.project_id === projectId, {
        host,
        repo_key: repoKey,
        updated_at: now,
      });
      if (changed.length > 0) return;
      tables.insert('ci_repo_keys', {
        project_id: projectId,
        host,
        repo_key: repoKey,
        created_at: now,
        updated_at: now,
      });
    },
    async projectsFor(host, repoKey) {
      return orderBy(
        tables.select('ci_repo_keys').filter((r) => r.host === host && r.repo_key === repoKey),
        [(r) => r.updated_at, 'desc'],
        [(r) => r.project_id]
      ).map((r) => r.project_id);
    },
  };
}

import { orderBy } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import { ciEnvironmentFromRow } from './record';
import type { CiEnvironmentStore } from './types';

export function memoryCiEnvironments(tables: MemoryTables): CiEnvironmentStore {
  return {
    async list(projectId) {
      return orderBy(
        tables.select('ci_environments').filter((r) => r.project_id === projectId),
        [(r) => r.position]
      ).map(ciEnvironmentFromRow);
    },
    async replace(projectId, environments, updatedBy) {
      const wanted = projectId;
      const now = new Date();
      tables.delete('ci_environments', (r) => r.project_id === wanted);
      environments.forEach((environment, position) => {
        tables.insert('ci_environments', {
          project_id: projectId,
          position,
          name: environment.name,
          production: environment.production,
          branches: toJson(environment.branches),
          updated_by: updatedBy,
          created_at: now,
          updated_at: now,
        });
      });
    },
  };
}

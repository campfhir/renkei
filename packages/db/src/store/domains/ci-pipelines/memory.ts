import { toJson, type MemoryTables } from '../../memory/tables';
import { ciPipelineFromRow } from './record';
import type { CiPipelineStore } from './types';

export function memoryCiPipelines(tables: MemoryTables): CiPipelineStore {
  return {
    async get(projectId) {
      const row = tables.first('ci_pipelines', (r) => r.project_id === projectId);
      return row ? ciPipelineFromRow(row) : null;
    },
    async save(projectId, input) {
      const wanted = projectId;
      const now = new Date();
      const changed = tables.update('ci_pipelines', (r) => r.project_id === wanted, {
        host: input.host,
        spec: toJson(input.spec),
        updated_by: input.updatedBy,
        updated_at: now,
      });
      if (changed.length > 0) return;
      tables.insert('ci_pipelines', {
        project_id: projectId,
        host: input.host,
        spec: toJson(input.spec),
        written_text: null,
        written_at: null,
        pull_request_url: null,
        updated_by: input.updatedBy,
        created_at: now,
        updated_at: now,
      });
    },
    async markWritten(projectId, input) {
      const wanted = projectId;
      return (
        tables.update('ci_pipelines', (r) => r.project_id === wanted, {
          written_text: input.text,
          written_at: new Date(),
          pull_request_url: input.pullRequestUrl,
        }).length > 0
      );
    },
  };
}

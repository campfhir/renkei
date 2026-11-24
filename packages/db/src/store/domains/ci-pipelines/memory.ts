import { orderBy } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import { ciPipelineFromRow } from './record';
import type { CiPipelineStore } from './types';

export function memoryCiPipelines(tables: MemoryTables): CiPipelineStore {
  return {
    async get(projectId, branch) {
      const row = tables.first(
        'ci_pipelines',
        (r) => r.project_id === projectId && r.branch === branch
      );
      return row ? ciPipelineFromRow(row) : null;
    },
    async listForProject(projectId) {
      return orderBy(
        tables.select('ci_pipelines').filter((r) => r.project_id === projectId),
        [(r) => r.branch]
      ).map(ciPipelineFromRow);
    },
    async findByRepoKey(host, repoKey) {
      return orderBy(
        tables.select('ci_pipelines').filter((r) => r.host === host && r.repo_key === repoKey),
        [(r) => r.updated_at, 'desc'],
        [(r) => r.project_id],
        [(r) => r.branch]
      ).map(ciPipelineFromRow);
    },
    async setRepoKey(projectId, repoKey) {
      const wanted = projectId;
      return (
        tables.update('ci_pipelines', (r) => r.project_id === wanted, { repo_key: repoKey })
          .length > 0
      );
    },
    async save(projectId, branch, input) {
      const mine = (r: { project_id: string; branch: string }) =>
        r.project_id === projectId && r.branch === branch;
      const now = new Date();
      const changed = tables.update('ci_pipelines', mine, {
        host: input.host,
        spec: toJson(input.spec),
        updated_by: input.updatedBy,
        updated_at: now,
      });
      if (changed.length > 0) return;
      tables.insert('ci_pipelines', {
        project_id: projectId,
        branch,
        host: input.host,
        spec: toJson(input.spec),
        written_text: null,
        written_at: null,
        pull_request_url: null,
        repo_key: null,
        updated_by: input.updatedBy,
        created_at: now,
        updated_at: now,
      });
    },
    async markWritten(projectId, branch, input) {
      return (
        tables.update('ci_pipelines', (r) => r.project_id === projectId && r.branch === branch, {
          written_text: input.text,
          written_at: new Date(),
          pull_request_url: input.pullRequestUrl,
        }).length > 0
      );
    },
  };
}

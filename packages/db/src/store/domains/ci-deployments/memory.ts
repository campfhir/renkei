import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { ciDeploymentFromRow } from './record';
import type { CiDeploymentStore } from './types';

export function memoryCiDeployments(tables: MemoryTables): CiDeploymentStore {
  return {
    async record(report) {
      const finished = report.status === 'started' ? null : report.at;
      const same = (r: { project_id: string; environment: string; run_id: string }) =>
        r.project_id === report.projectId &&
        r.environment === report.environment &&
        r.run_id === report.runId;
      const existing = tables.first('ci_deployments', same);
      if (existing) {
        if (report.status !== 'started') {
          tables.update('ci_deployments', same, {
            status: report.status,
            detail: report.detail,
            finished_at: finished,
            commit_sha: report.commitSha,
            target: report.target ?? existing.target,
            updated_at: new Date(),
          });
        }
        return existing.id;
      }
      const now = new Date();
      return tables.insert('ci_deployments', {
        id: globalThis.crypto.randomUUID(),
        project_id: report.projectId,
        environment: report.environment,
        status: report.status,
        commit_sha: report.commitSha,
        branch: report.branch,
        target: report.target,
        run_id: report.runId,
        run_url: report.runUrl,
        detail: report.detail,
        actor: report.actor,
        started_at: report.at,
        finished_at: finished,
        created_at: now,
        updated_at: now,
      }).id;
    },
    async latest(projectIds) {
      const sorted = orderBy(
        tables.select('ci_deployments').filter((r) => projectIds.includes(r.project_id)),
        [(r) => r.project_id],
        [(r) => r.environment],
        [(r) => r.started_at, 'desc'],
        [(r) => r.id, 'desc']
      );
      const seen = new Set<string>();
      return sorted
        .filter((r) => {
          const key = `${r.project_id}\u0000${r.environment}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map(ciDeploymentFromRow);
    },
    async recent(projectIds, limit) {
      return orderBy(
        tables.select('ci_deployments').filter((r) => projectIds.includes(r.project_id)),
        [(r) => r.started_at, 'desc'],
        [(r) => r.id, 'desc']
      )
        .slice(0, limit)
        .map(ciDeploymentFromRow);
    },
  };
}

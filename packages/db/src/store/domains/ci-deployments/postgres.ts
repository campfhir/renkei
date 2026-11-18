import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ciDeploymentFromRow } from './record';
import type { CiDeploymentStore } from './types';

export function postgresCiDeployments(db: () => Kysely<DB>): CiDeploymentStore {
  return {
    async record(report) {
      const finished = report.status === 'started' ? null : report.at;
      const row = await db()
        .insertInto('ci_deployments')
        .values({
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
        })
        .onConflict((oc) =>
          oc.columns(['project_id', 'environment', 'run_id']).doUpdateSet(
            report.status === 'started'
              ? // A late start keeps an outcome already in.
                { updated_at: sql`NOW()` }
              : {
                  status: report.status,
                  detail: report.detail,
                  finished_at: finished,
                  commit_sha: report.commitSha,
                  target: report.target ?? sql`ci_deployments.target`,
                  updated_at: sql`NOW()`,
                }
          )
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async latest(projectIds) {
      if (projectIds.length === 0) return [];
      const rows = await db()
        .selectFrom('ci_deployments')
        .selectAll()
        .distinctOn(['project_id', 'environment'])
        .where('project_id', 'in', projectIds)
        .orderBy('project_id')
        .orderBy('environment')
        .orderBy('started_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      return rows.map(ciDeploymentFromRow);
    },
    async recent(projectIds, limit) {
      if (projectIds.length === 0) return [];
      const rows = await db()
        .selectFrom('ci_deployments')
        .selectAll()
        .where('project_id', 'in', projectIds)
        .orderBy('started_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(ciDeploymentFromRow);
    },
  };
}

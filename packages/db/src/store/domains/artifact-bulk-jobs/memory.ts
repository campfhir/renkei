import { toJson, type MemoryTables } from '../../memory/tables';
import { orderBy, page } from '../../memory/order';
import { ARTIFACT_BULK_JOBS as TABLE, artifactBulkJobFromRow, resultsValue } from './record';
import type { ArtifactBulkJobStore } from './types';

export function memoryArtifactBulkJobs(tables: MemoryTables): ArtifactBulkJobStore {
  return {
    async create(job) {
      const now = new Date();
      const row = tables.insert(TABLE, {
        id: job.id,
        subject: job.subject,
        action: job.action,
        project_id: job.projectId,
        mode: job.mode,
        artifact_ids: toJson(job.artifactIds),
        results: [],
        status: 'queued',
        last_error: null,
        created_at: now,
        updated_at: now,
        finished_at: null,
        dismissed_at: null,
      });
      return artifactBulkJobFromRow(row);
    },
    async get(id) {
      const row = tables.first(TABLE, (r) => r.id === id);
      return row ? artifactBulkJobFromRow(row) : null;
    },
    async listShown(subject, limit) {
      const rows = tables.select(TABLE, (r) => r.subject === subject && r.dismissed_at === null);
      return page(orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id, 'desc']), limit).map(
        artifactBulkJobFromRow
      );
    },
    async startQueued(id) {
      return (
        tables.update(TABLE, (r) => r.id === id && r.status === 'queued', {
          status: 'running',
          updated_at: new Date(),
        }).length > 0
      );
    },
    async reclaimStale(id, staleMs) {
      const now = new Date();
      return (
        tables.update(
          TABLE,
          (r) =>
            r.id === id &&
            r.status === 'running' &&
            r.updated_at.getTime() < now.getTime() - staleMs,
          { updated_at: now }
        ).length > 0
      );
    },
    async recordResults(id, results) {
      return (
        tables.update(TABLE, (r) => r.id === id && r.status === 'running', {
          results: toJson(resultsValue(results)),
          updated_at: new Date(),
        }).length > 0
      );
    },
    async finish(id, outcome) {
      const now = new Date();
      return (
        tables.update(
          TABLE,
          (r) => r.id === id && (r.status === 'queued' || r.status === 'running'),
          {
            status: outcome.status,
            ...(outcome.lastError !== undefined ? { last_error: outcome.lastError } : {}),
            finished_at: now,
            updated_at: now,
            ...(outcome.dismiss ? { dismissed_at: now } : {}),
          }
        ).length > 0
      );
    },
    async dismiss(id, subject) {
      return (
        tables.update(
          TABLE,
          (r) =>
            r.id === id &&
            r.subject === subject &&
            r.finished_at !== null &&
            r.dismissed_at === null,
          { dismissed_at: new Date() }
        ).length > 0
      );
    },
    async listRunnable(staleMs, limit) {
      const cutoff = Date.now() - staleMs;
      const rows = tables.select(
        TABLE,
        (r) => r.status === 'queued' || (r.status === 'running' && r.updated_at.getTime() < cutoff)
      );
      return page(orderBy(rows, [(r) => r.updated_at], [(r) => r.id]), limit).map((r) => ({
        id: r.id,
        status: r.status === 'queued' ? ('queued' as const) : ('running' as const),
      }));
    },
  };
}

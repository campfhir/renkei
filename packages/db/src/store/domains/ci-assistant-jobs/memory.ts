import { toJson, type MemoryTables } from '../../memory/tables';
import { jobFromRow, outcomeColumns } from './record';
import type { CiAssistantJobStore } from './types';

export function memoryCiAssistantJobs(tables: MemoryTables): CiAssistantJobStore {
  return {
    async create(job, at) {
      return jobFromRow(
        tables.insert('ci_assistant_jobs', {
          id: job.id,
          subject: job.subject,
          project_id: job.projectId,
          status: 'running',
          step: job.step,
          result: null,
          error: null,
          created_at: at,
          updated_at: at,
          finished_at: null,
        })
      );
    },
    async find(subject, id) {
      const row = tables.first('ci_assistant_jobs', (r) => r.subject === subject && r.id === id);
      return row ? jobFromRow(row) : null;
    },
    async progress(id, step, at) {
      return (
        tables.update('ci_assistant_jobs', (r) => r.id === id && r.status === 'running', {
          step,
          updated_at: at,
        }).length > 0
      );
    },
    async finish(id, outcome, at) {
      const columns = outcomeColumns(outcome, at);
      return (
        tables.update('ci_assistant_jobs', (r) => r.id === id && r.status === 'running', {
          ...columns,
          result: columns.result === null ? null : toJson(columns.result),
        }).length > 0
      );
    },
    async pruneBefore(before) {
      return tables.delete('ci_assistant_jobs', (r) => r.created_at.getTime() < before.getTime())
        .length;
    },
  };
}

import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { sandboxFileFromRow, sandboxFileValues } from './record';
import type { SandboxFileStore } from './types';

function sum(rows: { size_bytes: number }[]): number {
  return rows.reduce((total, row) => total + Number(row.size_bytes), 0);
}

export function memorySandboxFiles(tables: MemoryTables): SandboxFileStore {
  return {
    async insert(file) {
      return sandboxFileFromRow(
        tables.insert('sandbox_files', { ...sandboxFileValues(file), created_at: new Date() })
      );
    },
    async list(subject, batchId) {
      const rows = tables.select(
        'sandbox_files',
        (r) => r.subject === subject && (!batchId || r.batch_id === batchId)
      );
      return orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]).map(sandboxFileFromRow);
    },
    async countForSubject(subject) {
      return tables.select('sandbox_files', (r) => r.subject === subject).length;
    },
    async totalBytesForSubject(subject) {
      return sum(tables.select('sandbox_files', (r) => r.subject === subject));
    },
    async countForBatch(batchId) {
      return tables.select('sandbox_files', (r) => r.batch_id === batchId).length;
    },
    async totalBytesForBatch(batchId) {
      return sum(tables.select('sandbox_files', (r) => r.batch_id === batchId));
    },
    async get(subject, id) {
      const wanted = id;
      const row = tables.first('sandbox_files', (r) => r.subject === subject && r.id === wanted);
      return row ? sandboxFileFromRow(row) : null;
    },
    async delete(subject, id) {
      const wanted = id;
      const [row] = tables.delete('sandbox_files', (r) => r.subject === subject && r.id === wanted);
      return row ? sandboxFileFromRow(row) : null;
    },
    async listExpired(before, limit) {
      const rows = tables.select('sandbox_files', (r) => r.expires_at.getTime() < before.getTime());
      return page(orderBy(rows, [(r) => r.expires_at], [(r) => r.id]), limit).map(
        sandboxFileFromRow
      );
    },
    async deleteById(id) {
      const wanted = id;
      tables.delete('sandbox_files', (r) => r.id === wanted);
    },
  };
}

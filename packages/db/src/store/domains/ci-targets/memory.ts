import { orderBy } from '../../memory/order';
import { toJson, uniqueViolation, type MemoryTables } from '../../memory/tables';
import { ciTargetFromRow } from './record';
import type { CiTargetStore } from './types';

export function memoryCiTargets(tables: MemoryTables): CiTargetStore {
  // The page answers a taken name as "taken".
  const refuseTaken = (name: string, except?: string) => {
    if (tables.first('ci_targets', (r) => r.name === name && r.id !== except)) {
      throw uniqueViolation('ci_targets', 'idx_ci_targets_name');
    }
  };
  return {
    async list() {
      return orderBy(tables.select('ci_targets'), [(r) => r.name], [(r) => r.id]).map(
        ciTargetFromRow
      );
    },
    async get(id) {
      const row = tables.first('ci_targets', (r) => r.id === id);
      return row ? ciTargetFromRow(row) : null;
    },
    async create(input) {
      refuseTaken(input.name);
      const now = new Date();
      return tables.insert('ci_targets', {
        id: globalThis.crypto.randomUUID(),
        name: input.name,
        description: input.description,
        kind: input.kind,
        labels: toJson(input.labels),
        created_by: input.createdBy,
        created_at: now,
        updated_at: now,
      }).id;
    },
    async update(id, input) {
      const wanted = id;
      refuseTaken(input.name, wanted);
      return (
        tables.update('ci_targets', (r) => r.id === wanted, {
          name: input.name,
          description: input.description,
          kind: input.kind,
          labels: toJson(input.labels),
          updated_at: new Date(),
        }).length > 0
      );
    },
    async delete(id) {
      const wanted = id;
      return tables.delete('ci_targets', (r) => r.id === wanted).length > 0;
    },
  };
}

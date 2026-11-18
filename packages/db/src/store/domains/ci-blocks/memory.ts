import { orderBy } from '../../memory/order';
import { toJson, uniqueViolation, type MemoryTables } from '../../memory/tables';
import { ciBlockFromRow, ciBlockVersionFromRow } from './record';
import type { CiBlockStore } from './types';

export function memoryCiBlocks(tables: MemoryTables): CiBlockStore {
  return {
    async list() {
      return orderBy(tables.select('ci_blocks'), [(r) => r.name], [(r) => r.id]).map(
        ciBlockFromRow
      );
    },
    async get(id) {
      const row = tables.first('ci_blocks', (r) => r.id === id);
      return row ? ciBlockFromRow(row) : null;
    },
    async getByKey(key) {
      const row = tables.first('ci_blocks', (r) => r.key === key);
      return row ? ciBlockFromRow(row) : null;
    },
    async create(input) {
      // The page answers a taken key as "taken".
      if (tables.first('ci_blocks', (r) => r.key === input.key)) {
        throw uniqueViolation('ci_blocks', 'idx_ci_blocks_key');
      }
      const now = new Date();
      return tables.insert('ci_blocks', {
        id: globalThis.crypto.randomUUID(),
        key: input.key,
        name: input.name,
        description: input.description,
        kind: input.kind,
        draft: toJson(input.draft),
        latest_version: 0,
        created_by: input.createdBy,
        created_at: now,
        updated_at: now,
      }).id;
    },
    async saveDraft(id, input) {
      const wanted = id;
      return (
        tables.update('ci_blocks', (r) => r.id === wanted, {
          name: input.name,
          description: input.description,
          kind: input.kind,
          draft: toJson(input.draft),
          updated_at: new Date(),
        }).length > 0
      );
    },
    async discardDraft(id) {
      const wanted = id;
      return (
        tables.update('ci_blocks', (r) => r.id === wanted && r.draft !== null, {
          draft: null,
          updated_at: new Date(),
        }).length > 0
      );
    },
    async publish(id, publishedBy) {
      const block = tables.first('ci_blocks', (r) => r.id === id);
      if (!block || block.draft === null) return null;
      const version = Number(block.latest_version) + 1;
      tables.insert('ci_block_versions', {
        block_id: id,
        version,
        definition: block.draft,
        published_by: publishedBy,
        published_at: new Date(),
      });
      tables.update('ci_blocks', (r) => r.id === id, {
        draft: null,
        latest_version: version,
        updated_at: new Date(),
      });
      return version;
    },
    async listVersions(id) {
      return orderBy(
        tables.select('ci_block_versions', (r) => r.block_id === id),
        [(r) => Number(r.version), 'desc']
      ).map(ciBlockVersionFromRow);
    },
    async getVersion(id, version) {
      const row = tables.first(
        'ci_block_versions',
        (r) => r.block_id === id && Number(r.version) === version
      );
      return row ? ciBlockVersionFromRow(row) : null;
    },
    async delete(id) {
      const wanted = id;
      const deleted = tables.delete('ci_blocks', (r) => r.id === wanted).length > 0;
      // The versions go with it, as the foreign key's cascade takes them.
      if (deleted) tables.delete('ci_block_versions', (r) => r.block_id === wanted);
      return deleted;
    },
  };
}
